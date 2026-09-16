# Code review checklist

Reject or flag changes that:
- duplicate existing logic,
- introduce new public APIs without clear need,
- add files that could have been changes to existing files,
- add dependencies without approval,
- add speculative abstractions,
- leave dead code behind,
- increase complexity without reducing duplication,
- skip relevant tests.

For every PR/diff, report:
1. New files added.
2. New functions/classes/components added.
3. Removed or simplified code.
4. Duplicated logic risks.
5. Opportunities to refactor instead of adding code.
6. Tests/checks run.

## Second-pass simplification review

When asked for a simplification review, assume the feature is functionally correct and review only for maintainability and unnecessary code growth.

Flag:
- duplicated or near-duplicated logic,
- unnecessary new functions/classes/components,
- helpers with only one call site,
- new files that could fit existing modules,
- abstractions added before they are needed,
- wrappers that do not clarify behavior,
- old code left behind after replacement,
- unnecessary dependencies/imports,
- public APIs wider than needed.

Prefer recommendations that:
- delete code,
- inline one-off helpers,
- merge parallel implementations,
- reuse existing abstractions,
- narrow interfaces,
- reduce branching,
- reduce conceptual surface area.

Avoid recommending speculative abstractions.