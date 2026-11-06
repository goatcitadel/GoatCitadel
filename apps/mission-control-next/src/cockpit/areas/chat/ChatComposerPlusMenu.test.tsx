// @vitest-environment happy-dom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import type { ComposerProps } from './ChatTextComposer.types';
const load=vi.hoisted(()=>({started:vi.fn<()=>Promise<void>>()}));
let root:Root,host:HTMLDivElement,Plus:typeof import('./ChatComposerPlusMenu').ChatComposerPlusMenu;
let useSources: typeof import('./ChatComposerTools').useComposerSources;
beforeEach(async()=>{vi.resetModules();load.started.mockReset().mockResolvedValue(undefined);
 const primitive=(await vi.importActual<typeof import('radix-ui')>('radix-ui')).Popover;
 vi.doMock('../../ui/PopoverRuntime',async()=>{await load.started();return {Root:primitive.Root,Trigger:primitive.Trigger,Content:primitive.Content};});
 Plus=(await import('./ChatComposerPlusMenu')).ChatComposerPlusMenu;
 useSources=(await import('./ChatComposerTools')).useComposerSources;
 host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.doUnmock('../../ui/PopoverRuntime');});
function composerProps(overrides: Partial<ComposerProps> = {}): ComposerProps {
  return {
    queueItems: [],
    onResumeAll: vi.fn(),
    onRemoveQueuedItem: vi.fn(),
    draft: "Hello",
    onDraftChange: vi.fn(),
    onSend: vi.fn(),
    onStopActiveTurn: vi.fn(),
    canSend: true,
    sending: false,
    hasActiveStream: false,
    historicalReadOnly: false,
    onReturnToLatest: vi.fn(),
    sessionControlBanner: null,
    pendingApproval: null,
    pendingUserInput: null,
    pendingAttachments: [],
    editingTurnId: null,
    onCancelEdit: vi.fn(),
    routeBoundaryAckRequired: false,
    routeBoundaryAcknowledged: false,
    routePreflight: null,
    routePreflightError: null,
    routePreflightLoading: false,
    providerOptions: [],
    selectedProviderId: undefined,
    selectedModel: undefined,
    modelSwitchDisabled: false,
    onRequestProviderChange: vi.fn(),
    onRequestModelChange: vi.fn(),
    currentThinkingLevel: "standard",
    onSetThinkingLevel: vi.fn(),
    activePersonality: null,
    onOpenPersonalitiesSettings: vi.fn(),
    planningMode: "off",
    onTogglePlanningMode: vi.fn(),
    currentWebMode: "off",
    onSetWebMode: vi.fn(),
    currentReviewDepth: "off",
    onToggleReviewMode: vi.fn(),
    onRemoveAttachment: vi.fn(),
    fileInputRef: createRef<HTMLInputElement>(),
    onAttachFiles: vi.fn(),
    onUploadFiles: vi.fn(),
    onAcknowledgeRouteBoundary: vi.fn(),
    commandSuggestions: [],
    commandIndex: 0,
    onApplyDraftCommand: vi.fn(),
    onComposerKeyDown: vi.fn(),
    onComposerPaste: vi.fn(),
    onDragEnter: vi.fn(),
    onDragOver: vi.fn(),
    onDragLeave: vi.fn(),
    onDrop: vi.fn(),
    isDragActive: false,
    composerRef: createRef<HTMLTextAreaElement>(),
    selectedSessionId: "session-1",
    ...overrides,
  };
}
const button=(label:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(n=>n.textContent?.trim()===label || n.querySelector('span')?.textContent===label)!;
function Harness({props,onToggle}:{props:ComposerProps;onToggle:()=>void}) {
 const sources=useSources(props.selectedSessionId ?? '', 'sources', props.externalSourceControls?.attachments.length);
 return <><textarea aria-label="Draft" defaultValue="Keep this"/><input id="destination"/><Plus props={props} sources={{...sources,onToggle}} channelConversation={false}/></>;
}
async function render(props=composerProps(),onToggle=vi.fn()) {await act(async()=>root.render(<Harness props={props} onToggle={onToggle}/>));}
async function open(){const trigger=host.querySelector<HTMLButtonElement>('[aria-label="Add and options"]')!;trigger.focus();await act(async()=>trigger.click());await vi.waitFor(()=>expect(button('Attach files')).toBeTruthy());}
it('attaches files exactly once',async()=>{const props=composerProps();await render(props);await open();await act(async()=>button('Attach files').click());expect(props.onAttachFiles).toHaveBeenCalledOnce();});
it.each(['sending','historicalReadOnly'] as const)('retains disabled modes for %s',async field=>{await render(composerProps({[field]:true}));await open();expect(button('Attach files').disabled).toBe(true);const modes=document.querySelector('[aria-label="Modes"]')!;const controls=[...modes.querySelectorAll<HTMLButtonElement|HTMLSelectElement>('button,select')];expect(controls.length).toBeGreaterThan(0);expect(controls.every(n=>n.disabled)).toBe(true);});
it.each(['commands','sources'])('preserves the deliberate %s focus handoff',async action=>{
 const handoff=vi.fn(()=>host.querySelector<HTMLInputElement>('#destination')!.focus());
 const composerPalette = {
  enabled:true,globalOpen:false,query:'',loading:false,failures:[],onOpen:handoff,
  onClose:vi.fn(),onQueryChange:vi.fn(),onIndexChange:vi.fn(),onSelect:vi.fn(),
 } satisfies NonNullable<ComposerProps['composerPalette']>;
 const externalSourceControls = {
  attachments:[],candidates:[],candidatesSupported:true,selectedAttachmentIds:[],loading:false,
  error:null,canMutate:true,busyAttachmentId:null,onLoadCandidates:vi.fn(),onToggleSelect:vi.fn(),
  onClearSelection:vi.fn(),onAttach:vi.fn(),onReload:vi.fn(),onDetach:vi.fn(),onRequestKnowledgeSnapshot:vi.fn(),
 } satisfies NonNullable<ComposerProps['externalSourceControls']>;
 const props=composerProps({composerPalette,externalSourceControls});
 await render(props,handoff);await open();const target=action==='commands'?button('Commands and context'):[...document.querySelectorAll<HTMLButtonElement>('button')].find(n=>/Sources/.test(n.textContent??''))!;
 await act(async()=>target.click());expect(handoff).toHaveBeenCalledOnce();await vi.waitFor(()=>expect(document.activeElement).toBe(host.querySelector('#destination')));
});
it('requests readiness when voice and images opens',async()=>{const ready=vi.fn();await render(composerProps({onMediaControlsOpenChange:ready}));await open();const details=document.querySelector('details')!;await act(async()=>{details.open=true;details.dispatchEvent(new Event('toggle'));});expect(ready).toHaveBeenCalledWith(true);});
it('keeps the composer usable without mutations when optional code rejects',async()=>{let reject!:(cause:Error)=>void;load.started.mockImplementationOnce(()=>new Promise<void>((_,fail)=>{reject=fail;}));const props=composerProps();await render(props);const trigger=host.querySelector<HTMLButtonElement>('[aria-label="Add and options"]')!;trigger.focus();await act(async()=>trigger.click());await vi.waitFor(()=>expect(load.started).toHaveBeenCalledOnce());await act(async()=>reject(new Error('fixture failure')));await vi.waitFor(()=>expect(document.querySelector('[role="status"]')?.textContent).toMatch(/could not load/i));const draft=host.querySelector('textarea')!;draft.focus();expect(document.activeElement).toBe(draft);expect(draft.value).toBe('Keep this');expect(props.onAttachFiles).not.toHaveBeenCalled();expect(props.onTogglePlanningMode).not.toHaveBeenCalled();});
