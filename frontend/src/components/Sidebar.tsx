import {
  Bookmark,
  BookOpenCheck,
  CircleQuestionMark,
  FolderKanban,
  ListTodo,
  Newspaper,
  Notebook,
  Pin,
  ScrollText,
  Search as SearchIcon,
  Settings2,
  type LucideIcon,
} from 'lucide-react'
import { useState } from 'react'
import claudeskLogoUrl from '../assets/claudesk-logo.svg'
import { prepareActiveNoteTransition } from '../lib/noteEditorRegistry'
import { useStore, type Tab } from '../store'
import { Dialog, DialogClose, DialogTitle } from './ui/dialog'
import {
  Sidebar as SidebarRoot,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from './ui/sidebar'

const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'digest', label: 'DIGEST', icon: Newspaper },
  { id: 'saved', label: 'SAVED', icon: Bookmark },
  { id: 'readingQueue', label: 'READING QUEUE', icon: BookOpenCheck },
  { id: 'notes', label: 'NOTES', icon: Notebook },
  { id: 'tasks', label: 'TASKS', icon: ListTodo },
  { id: 'log', label: 'LOG', icon: ScrollText },
  { id: 'projects', label: 'PROJECTS', icon: FolderKanban },
  { id: 'search', label: 'SEARCH', icon: SearchIcon },
]

function formatReleaseDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return 'Unreleased build'

  const date = new Date(Date.UTC(year, month - 1, day))
  const formattedDate = new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
    year: 'numeric',
  }).format(date)
  return `Released ${formattedDate}`
}

function AboutDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const releaseLabel = formatReleaseDate(__CLAUDESK_RELEASE_DATE__)

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      ariaDescribedBy="claudesk-about-details"
      className="max-w-[360px] px-8 py-7"
    >
      <div className="flex justify-end">
        <DialogClose>Close</DialogClose>
      </div>
      <div className="flex flex-col items-center text-center">
        <img
          src={claudeskLogoUrl}
          alt=""
          data-testid="claudesk-about-logo"
          className="size-20 select-none rounded-[18px] border border-border bg-bg"
          draggable={false}
        />
        <DialogTitle className="mt-7">
          <span className="block font-sans text-3xl font-semibold leading-none normal-case tracking-normal text-display">
            Claudesk
          </span>
        </DialogTitle>
        <p
          id="claudesk-about-details"
          className="mt-7 font-sans text-base font-medium leading-7 text-secondary"
        >
          Version {__CLAUDESK_VERSION__} · {releaseLabel}
        </p>
        <p className="mt-6 font-sans text-base font-medium text-secondary">
          © Claudesk contributors
        </p>
      </div>
    </Dialog>
  )
}

export default function Sidebar() {
  const [aboutOpen, setAboutOpen] = useState(false)
  const activeTab = useStore((s) => s.activeTab)
  const setActiveTab = useStore((s) => s.setActiveTab)
  const setIndexCollapsed = useStore((s) => s.setIndexCollapsed)

  async function openSettings() {
    if (activeTab === 'settings') return
    if (!(await prepareActiveNoteTransition())) return
    setActiveTab('settings')
  }

  return (
    <SidebarRoot
      aria-label="Primary navigation"
      className="border-r border-border"
    >
      <SidebarHeader className="justify-end group-data-[state=collapsed]:justify-center">
        <SidebarTrigger />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {TABS.map((tab) => {
                const Icon = tab.icon
                return (
                  <SidebarMenuItem key={tab.id}>
                    <SidebarMenuButton
                      isActive={activeTab === tab.id}
                      tooltip={tab.label}
                      onClick={() => {
                        setIndexCollapsed(false)
                        setActiveTab(tab.id)
                      }}
                    >
                      <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
                      <span className="min-w-0 truncate group-data-[state=collapsed]:hidden">{tab.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="mt-auto">
          <SidebarGroupLabel>PINNED</SidebarGroupLabel>
          <SidebarGroupContent>
            <div className="flex min-w-0 flex-col gap-2 px-2 py-2 text-muted group-data-[state=collapsed]:hidden">
              <Pin size={14} strokeWidth={1.7} aria-hidden="true" />
              <p className="font-mono text-[10px] uppercase leading-relaxed tracking-widest">
                No pinned items yet.
              </p>
            </div>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="ABOUT"
              aria-pressed={aboutOpen}
              onClick={() => setAboutOpen(true)}
            >
              <CircleQuestionMark size={14} strokeWidth={1.75} aria-hidden="true" />
              <span className="min-w-0 truncate group-data-[state=collapsed]:hidden">ABOUT</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={activeTab === 'settings'}
              tooltip="SETTINGS"
              onClick={() => { void openSettings() }}
            >
              <Settings2 size={14} strokeWidth={1.75} aria-hidden="true" />
              <span className="min-w-0 truncate group-data-[state=collapsed]:hidden">SETTINGS</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
    </SidebarRoot>
  )
}
