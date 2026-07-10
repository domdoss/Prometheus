import { ToolsetDef, registry } from './tool-registry.js';

export const TOOLSETS: Record<string, ToolsetDef> = {
    file:      { name: 'file',      tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'], tier: 'both' },
    web:       { name: 'web',       tools: ['WebSearch', 'WebFetch'], tier: 'public' },
    browser:   { name: 'browser',   tools: ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type',
                                             'browser_press_key', 'browser_select_option', 'browser_hover',
                                             'browser_screenshot', 'browser_evaluate', 'browser_wait_for',
                                             'browser_tabs', 'browser_back', 'browser_current_url'], tier: 'public' },
    terminal:  { name: 'terminal',  tools: ['Bash', 'desktop_screenshot', 'desktop_click', 'desktop_type'], tier: 'public' },
    projects:  { name: 'projects',  tools: ['create_project','get_project','update_project','archive_project',
                                             'complete_project','delete_project','list_projects'], tier: 'public' },
    worktasks: { name: 'worktasks', tools: ['create_work_task','list_work_tasks','update_work_task',
                                             'delete_work_task'], tier: 'public' },
    tasks:     { name: 'tasks',     tools: ['schedule_task','list_tasks','pause_task','resume_task',
                                             'cancel_task','update_task'], tier: 'public' },
    deliverables: { name: 'deliverables', tools: ['add_deliverable','toggle_deliverable','delete_deliverable'], tier: 'public' },
    blockers:  { name: 'blockers',  tools: ['add_blocker','delete_blocker','add_priority','delete_priority',
                                             'update_financials'], tier: 'public' },
    tracking:  { name: 'tracking',  tools: ['log_time','start_timer','stop_timer'], tier: 'public' },
    email:     { name: 'email',     tools: ['read_emails','send_email','get_email','refresh_email_cache',
                                             'get_cached_emails'], tier: 'private' },
    calendar:  { name: 'calendar',  tools: ['create_calendar_event','list_calendar_events',
                                             'update_calendar_event','delete_calendar_event'], tier: 'private' },
    contacts:  { name: 'contacts',  tools: ['list_contacts','search_contacts','get_contact',
                                             'create_contact','update_contact','delete_contact'], tier: 'private' },
    todos:     { name: 'todos',     tools: ['list_todos','create_todo','complete_todo','delete_todo'], tier: 'private' },
    alarms:    { name: 'alarms',    tools: ['create_alarm','list_alarms','update_alarm','delete_alarm'], tier: 'private' },
    sms:       { name: 'sms',       tools: ['send_sms','read_sms'], tier: 'private' },
    chat:      { name: 'chat',      tools: ['get_chat_history','ping_user','attach_file','set_user_email'], tier: 'both' },
    admin:     { name: 'admin',     tools: ['register_group','list_api_keys','api_request'], tier: 'public' },
    documents: { name: 'documents', tools: ['generate_pdf','convert_file'], tier: 'public' },
    context:   { name: 'context',   tools: ['clear_context'], tier: 'public' },
    fabric:    { name: 'fabric',    tools: ['fabric_pattern'], tier: 'both' },
    agent:     { name: 'agent',     tools: ['byte','dexter','atlas','artemis','iris'], tier: 'public' },

    'byte-core':     { name: 'byte-core',     includes: ['projects','worktasks','deliverables','blockers','tracking','admin'] },
    'dexter-core':   { name: 'dexter-core',   includes: ['tasks'] },
    'atlas-core':    { name: 'atlas-core',    includes: ['web','browser','terminal','documents','admin'] },
    'artemis-core':  { name: 'artemis-core',  tools: ['Read','Grep','Glob','Bash','get_chat_history'] },
    'iris-core':     { name: 'iris-core',     includes: ['email','contacts','calendar','todos'] },
    'file-core':     { name: 'file-core',     includes: ['file','chat'] },
};

// Register all toolsets
for (const ts of Object.values(TOOLSETS)) {
    registry.registerToolset(ts);
}

export function resolveToolset(name: string): string[] {
    return registry.resolveToolset(name);
}

export function resolveMultipleToolsets(names: string[]): string[] {
    return registry.resolveMultipleToolsets(names);
}
