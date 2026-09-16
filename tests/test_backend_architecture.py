from __future__ import annotations

import ast
import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = ROOT / "claudesk"
ROUTE_METHODS = {"get", "post", "put", "patch", "delete", "options", "head"}
HTTP_METHODS = {"get", "post", "put", "patch", "delete", "options", "head", "request"}
SQL_EXECUTION_METHODS = {"execute", "executemany", "executescript"}


def _python_files(path: Path) -> list[Path]:
    return sorted(p for p in path.rglob("*.py") if "__pycache__" not in p.parts)


def _parse(path: Path) -> ast.Module:
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _module_name_for_path(path: Path) -> str:
    relative = path.relative_to(ROOT).with_suffix("")
    parts = list(relative.parts)
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def _package_name_for_path(path: Path) -> str:
    module_name = _module_name_for_path(path)
    if path.name == "__init__.py":
        return module_name
    return module_name.rpartition(".")[0]


def _resolve_import_from(node: ast.ImportFrom, path: Path) -> str:
    if node.level == 0:
        return node.module or ""
    relative_name = "." * node.level + (node.module or "")
    return importlib.util.resolve_name(relative_name, _package_name_for_path(path))


def _iter_import_targets(tree: ast.Module, path: Path):
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                yield node.lineno, alias.name, None, alias.asname
        elif isinstance(node, ast.ImportFrom):
            module_name = _resolve_import_from(node, path)
            for alias in node.names:
                yield node.lineno, module_name, alias.name, alias.asname


def _is_api_or_cli_import(module_name: str, imported_name: str | None) -> bool:
    if module_name == "claudesk.api" or module_name.startswith("claudesk.api."):
        return True
    if module_name == "claudesk.cli" or module_name.startswith("claudesk.cli."):
        return True
    return module_name == "claudesk" and imported_name in {"api", "cli"}


def _is_api_deps_get_conn_import(module_name: str, imported_name: str | None) -> bool:
    if module_name == "claudesk.api.deps":
        return imported_name in {None, "get_conn"}
    if module_name == "claudesk.api" and imported_name == "deps":
        return True
    return False


def _call_name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = _call_name(node.value)
        return f"{base}.{node.attr}" if base else node.attr
    return None


def _api_get_conn_dependency_names(tree: ast.Module, path: Path) -> set[str]:
    names: set[str] = set()
    for _lineno, module_name, imported_name, asname in _iter_import_targets(tree, path):
        if module_name == "claudesk.api.deps" and imported_name == "get_conn":
            names.add(asname or imported_name)
        elif module_name == "claudesk.api.deps" and imported_name is None:
            names.add(f"{asname or module_name}.get_conn")
        elif module_name == "claudesk.api" and imported_name == "deps":
            names.add(f"{asname or imported_name}.get_conn")
    return names


def _core_get_connection_names(tree: ast.Module, path: Path) -> set[str]:
    names: set[str] = set()
    for _lineno, module_name, imported_name, asname in _iter_import_targets(tree, path):
        if module_name == "claudesk.core.db" and imported_name == "get_connection":
            names.add(asname or imported_name)
        elif module_name == "claudesk.core.db" and imported_name is None:
            names.add(f"{asname or module_name}.get_connection")
        elif module_name == "claudesk.core" and imported_name == "db":
            names.add(f"{asname or imported_name}.get_connection")
    return names


def _is_route_decorator(decorator: ast.expr) -> bool:
    target = decorator.func if isinstance(decorator, ast.Call) else decorator
    return (
        isinstance(target, ast.Attribute)
        and target.attr in ROUTE_METHODS
        and isinstance(target.value, ast.Name)
        and target.value.id in {"router", "app"}
    )


def _iter_route_functions(tree: ast.Module):
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and any(
            _is_route_decorator(decorator) for decorator in node.decorator_list
        ):
            yield node


def _iter_arg_defaults(node: ast.FunctionDef | ast.AsyncFunctionDef):
    positional = list(node.args.posonlyargs) + list(node.args.args)
    positional_defaults = [None] * (len(positional) - len(node.args.defaults)) + list(node.args.defaults)
    for arg, default in zip(positional, positional_defaults):
        yield arg.arg, default
    for arg, default in zip(node.args.kwonlyargs, node.args.kw_defaults):
        yield arg.arg, default


def _depends_dependency_name(default: ast.expr | None) -> str | None:
    if not isinstance(default, ast.Call):
        return None
    if _call_name(default.func) not in {"Depends", "fastapi.Depends"}:
        return None
    if default.args:
        return _call_name(default.args[0])
    for keyword in default.keywords:
        if keyword.arg == "dependency":
            return _call_name(keyword.value)
    return None


def _looks_like_local_api_route(value: str) -> bool:
    lowered = value.lower()
    if lowered.startswith("/api"):
        return True
    return "/api" in lowered and ("localhost" in lowered or "127.0.0.1" in lowered)


def _string_fragments(node: ast.AST) -> list[str]:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [node.value]
    if isinstance(node, ast.JoinedStr):
        fragments: list[str] = []
        for value in node.values:
            fragments.extend(_string_fragments(value))
        return fragments
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        return [*_string_fragments(node.left), *_string_fragments(node.right)]
    if isinstance(node, ast.FormattedValue):
        return _string_fragments(node.value)
    return []


def _expr_refs_local_api_route(node: ast.AST, api_route_names: set[str]) -> bool:
    if any(_looks_like_local_api_route(fragment) for fragment in _string_fragments(node)):
        return True
    if isinstance(node, ast.Name):
        return node.id in api_route_names
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        return _expr_refs_local_api_route(node.left, api_route_names) or _expr_refs_local_api_route(
            node.right,
            api_route_names,
        )
    if isinstance(node, ast.JoinedStr):
        return any(_expr_refs_local_api_route(value, api_route_names) for value in node.values)
    if isinstance(node, ast.FormattedValue):
        return _expr_refs_local_api_route(node.value, api_route_names)
    return False


def _assigned_local_api_route_names(tree: ast.Module) -> set[str]:
    assignments: list[tuple[str, ast.AST]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    assignments.append((target.id, node.value))
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.value is not None:
            assignments.append((node.target.id, node.value))
        elif isinstance(node, ast.NamedExpr) and isinstance(node.target, ast.Name):
            assignments.append((node.target.id, node.value))

    names: set[str] = set()
    changed = True
    while changed:
        changed = False
        for name, value in assignments:
            if name not in names and _expr_refs_local_api_route(value, names):
                names.add(name)
                changed = True
    return names


def _assigned_sql_execution_target_names(tree: ast.Module) -> set[str]:
    names = {"conn", "context.conn"}
    assignments: list[tuple[str, ast.AST]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    assignments.append((target.id, node.value))
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.value is not None:
            assignments.append((node.target.id, node.value))
        elif isinstance(node, ast.NamedExpr) and isinstance(node.target, ast.Name):
            assignments.append((node.target.id, node.value))

    changed = True
    while changed:
        changed = False
        cursor_sources = {f"{name}.cursor" for name in names}
        for name, value in assignments:
            value_name = _call_name(value)
            value_call_name = _call_name(value.func) if isinstance(value, ast.Call) else None
            if name not in names and (value_name in names or value_call_name in cursor_sources):
                names.add(name)
                changed = True
    return names


def _direct_sql_execution_call_name(node: ast.Call, sql_target_names: set[str]) -> str | None:
    if not isinstance(node.func, ast.Attribute) or node.func.attr not in SQL_EXECUTION_METHODS:
        return None
    receiver_name = _call_name(node.func.value)
    if receiver_name in sql_target_names:
        return f"{receiver_name}.{node.func.attr}"
    if isinstance(node.func.value, ast.Call):
        receiver_call_name = _call_name(node.func.value.func)
        if receiver_call_name in {f"{name}.cursor" for name in sql_target_names}:
            return f"{receiver_call_name}().{node.func.attr}"
    return None


def _has_local_api_route_argument(node: ast.Call, api_route_names: set[str]) -> bool:
    values = list(node.args) + [keyword.value for keyword in node.keywords]
    return any(_expr_refs_local_api_route(value, api_route_names) for value in values)


def _is_http_api_call(node: ast.Call, api_route_names: set[str]) -> bool:
    name = _call_name(node.func) or ""
    if "." not in name:
        return False
    method_name = name.rpartition(".")[2]
    if method_name not in HTTP_METHODS:
        return False
    return _has_local_api_route_argument(node, api_route_names)


class BackendArchitectureTests(unittest.TestCase):
    def test_core_does_not_import_api_or_cli(self) -> None:
        violations: list[str] = []
        for path in _python_files(SOURCE_ROOT / "core"):
            tree = _parse(path)
            for lineno, module_name, imported_name, _asname in _iter_import_targets(tree, path):
                if _is_api_or_cli_import(module_name, imported_name):
                    violations.append(f"{path.relative_to(ROOT)}:{lineno} imports {module_name}")

        self.assertEqual([], violations)

    def test_core_db_entrypoint_exports_only_infrastructure(self) -> None:
        allowed = {"SCHEMA_VERSION", "db_path", "get_connection", "init_db"}
        path = SOURCE_ROOT / "core" / "db" / "__init__.py"
        tree = _parse(path)
        violations: list[str] = []

        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                violations.append(f"{path.relative_to(ROOT)}:{node.lineno} defines {node.name}")
            if not isinstance(node, ast.ImportFrom):
                continue
            if node.module == "__future__":
                continue
            for alias in node.names:
                if alias.name not in allowed:
                    violations.append(
                        f"{path.relative_to(ROOT)}:{node.lineno} imports {alias.name}"
                    )

        self.assertEqual([], violations)

    def test_core_db_migrations_only_import_low_level_db_helpers(self) -> None:
        allowed_db_modules = {
            "claudesk.core.db.connection",
            "claudesk.core.db.schema",
            "claudesk.core.db.utils",
        }
        path = SOURCE_ROOT / "core" / "db" / "migrations.py"
        tree = _parse(path)
        violations: list[str] = []

        for lineno, module_name, imported_name, _asname in _iter_import_targets(tree, path):
            if module_name == "claudesk.core.db" or module_name.startswith("claudesk.core.db."):
                if module_name in allowed_db_modules:
                    continue
                violations.append(
                    f"{path.relative_to(ROOT)}:{lineno} imports {module_name}.{imported_name or ''}"
                )

        self.assertEqual([], violations)

    def test_fastapi_route_connection_dependencies_use_api_deps(self) -> None:
        violations: list[str] = []
        for path in _python_files(SOURCE_ROOT / "api"):
            tree = _parse(path)
            api_get_conn_names = _api_get_conn_dependency_names(tree, path)
            core_get_connection_names = _core_get_connection_names(tree, path)
            for route in _iter_route_functions(tree):
                for call in ast.walk(route):
                    if isinstance(call, ast.Call) and _call_name(call.func) in core_get_connection_names:
                        violations.append(
                            f"{path.relative_to(ROOT)}:{call.lineno} route {route.name} calls core.db.get_connection"
                        )
                for arg_name, default in _iter_arg_defaults(route):
                    dependency_name = _depends_dependency_name(default)
                    if dependency_name in core_get_connection_names:
                        violations.append(
                            f"{path.relative_to(ROOT)}:{route.lineno} route {route.name} "
                            f"parameter {arg_name} depends on core.db.get_connection"
                        )
                    if arg_name != "conn":
                        continue
                    if dependency_name not in api_get_conn_names:
                        violations.append(
                            f"{path.relative_to(ROOT)}:{route.lineno} route {route.name} has conn dependency {dependency_name!r}"
                        )

        self.assertEqual([], violations)

    def test_cli_and_jobs_do_not_import_api_get_conn(self) -> None:
        violations: list[str] = []
        paths = [SOURCE_ROOT / "cli.py", *_python_files(SOURCE_ROOT / "jobs")]
        for path in paths:
            tree = _parse(path)
            for lineno, module_name, imported_name, _asname in _iter_import_targets(tree, path):
                if _is_api_deps_get_conn_import(module_name, imported_name):
                    violations.append(f"{path.relative_to(ROOT)}:{lineno} imports {module_name}.{imported_name or ''}")

        self.assertEqual([], violations)

    def test_agent_capabilities_do_not_import_api_or_call_routes(self) -> None:
        violations: list[str] = []
        for path in _python_files(SOURCE_ROOT / "agent" / "capabilities"):
            tree = _parse(path)
            api_route_names = _assigned_local_api_route_names(tree)
            for lineno, module_name, imported_name, _asname in _iter_import_targets(tree, path):
                if module_name == "claudesk.api" or module_name.startswith("claudesk.api.") or (
                    module_name == "claudesk" and imported_name == "api"
                ):
                    violations.append(f"{path.relative_to(ROOT)}:{lineno} imports {module_name}")
            for node in ast.walk(tree):
                if isinstance(node, ast.Call) and _is_http_api_call(node, api_route_names):
                    violations.append(f"{path.relative_to(ROOT)}:{node.lineno} calls a local /api route")

        self.assertEqual([], violations)

    def test_agent_capabilities_do_not_execute_sql_directly(self) -> None:
        violations: list[str] = []
        for path in _python_files(SOURCE_ROOT / "agent" / "capabilities"):
            tree = _parse(path)
            sql_target_names = _assigned_sql_execution_target_names(tree)
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                call_name = _direct_sql_execution_call_name(node, sql_target_names)
                if call_name is not None:
                    violations.append(
                        f"{path.relative_to(ROOT)}:{node.lineno} calls {call_name}"
                    )

        self.assertEqual([], violations)

    def test_lancedb_imports_stay_inside_retrieval_vector_modules(self) -> None:
        violations: list[str] = []
        for path in _python_files(SOURCE_ROOT):
            tree = _parse(path)
            module_name = _module_name_for_path(path)
            if module_name.startswith("claudesk.core.retrieval"):
                continue
            for lineno, imported_module, _imported_name, _asname in _iter_import_targets(tree, path):
                if imported_module == "lancedb" or imported_module.startswith("lancedb."):
                    violations.append(f"{path.relative_to(ROOT)}:{lineno} imports {imported_module}")

        self.assertEqual([], violations)


if __name__ == "__main__":
    unittest.main()
