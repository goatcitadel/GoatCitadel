// @vitest-environment happy-dom
import { act } from "react";
import { createRoot,type Root } from "react-dom/client";
import { QueryClient,QueryClientProvider } from "@tanstack/react-query";
import { beforeEach,afterEach,expect,it,vi } from "vitest";
import type { NoteRecord } from "@goatcitadel/contracts";
import { listNotes,updateNote,createNote,archiveNote } from "@goatcitadel/mission-control-shared/api/personal-ops";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { LibraryNotesWorkspace } from "./LibraryNotesWorkspace";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
vi.mock("@goatcitadel/mission-control-shared/api/personal-ops",()=>({listNotes:vi.fn(),updateNote:vi.fn(),createNote:vi.fn(),archiveNote:vi.fn(),listNoteRevisions:vi.fn(async()=>({items:[]}))}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences",()=>({useUiPreferences:()=>({activeWorkspaceId:"one",activeCitadelId:"personal",showTechnicalDetails:false})}));
// Reminder editing is a separate owner; the actual note directory/editor and navigation remain real.
vi.mock("./LibraryReminders",()=>({LibraryReminders:()=>null}));
const note:NoteRecord={noteId:"owned",workspaceId:"one",title:"Repeated title",body:"Canonical owned note body",revision:1,lifecycleStatus:"active",tags:[],sourceRefs:[],createdAt:"2026-11-01T00:00:00.000Z",updatedAt:"2026-11-01T00:00:00.000Z"};
let root:Root,host:HTMLDivElement,client:QueryClient;
beforeEach(()=>{vi.clearAllMocks();__resetSessionDraftsForTests();window.history.replaceState(null,"","/library/notes?shell=cockpit&noteId=owned");host=document.createElement("div");document.body.append(host);root=createRoot(host);client=new QueryClient({defaultOptions:{queries:{retry:false}}});});
afterEach(async()=>{await act(async()=>root.unmount());client.clear();host.remove();});
async function render(){await act(async()=>root.render(<QueryClientProvider client={client}><CockpitNavigationProvider><LibraryNotesWorkspace workspaceId="one" /></CockpitNavigationProvider></QueryClientProvider>));}
function noWrites(){expect(createNote).not.toHaveBeenCalled();expect(updateNote).not.toHaveBeenCalled();expect(archiveNote).not.toHaveBeenCalled();expect(document.querySelector('[aria-label="Review note save"]')).toBeNull();}
it("opens the exact URL-selected note among same-title records in its real inline editor without saving",async()=>{
 vi.mocked(listNotes).mockResolvedValue({items:[{...note,noteId:"other",body:"Wrong same-title body"},note]});
 await render();await vi.waitFor(()=>expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Note editor"] textarea')?.value).toBe(note.body));
 expect(new URL(window.location.href).searchParams.get("noteId")).toBe(note.noteId);expect(listNotes).toHaveBeenCalledWith("one",{lifecycleStatus:"all"});noWrites();
});
it.each(["foreign","missing"])("refuses a %s selected owner without another note's editor or mutation",async(mode)=>{
 vi.mocked(listNotes).mockResolvedValue({items:mode==="foreign"?[{...note,workspaceId:"foreign"}]:[{...note,noteId:"another"}]});
 await render();await vi.waitFor(()=>expect(host.textContent).toContain("The selected note was not found in this workspace."));
 expect(host.querySelector('[aria-label="Note editor"]')).toBeNull();noWrites();
});
