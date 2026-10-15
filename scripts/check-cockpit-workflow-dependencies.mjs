import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";

export function findClassicWorkflowDependencies(file, source) {
 const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),findings=[];
 function report(node,reason){findings.push({file,line:ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1,reason});}
 function visit(node){
  if(ts.isImportDeclaration(node)&&!node.importClause?.isTypeOnly&&node.moduleSpecifier.text?.endsWith("/ClassicOwnerLink"))report(node,"Required owner must use the native compatibility boundary");
  if(ts.isJsxAttribute(node)&&node.name.getText(ast)==="href"&&node.initializer&&ts.isStringLiteral(node.initializer)&&/shell=classic/u.test(node.initializer.text)&&!["CockpitOwnerLink","SystemOwnerLink"].includes(node.parent.parent.tagName?.getText(ast)))report(node,"Required workflow must not render a raw Classic continuation");
  ts.forEachChild(node,visit);
 }visit(ast);return findings;
}
export async function checkCockpitWorkflowDependencies(root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")){
 const start=path.join(root,"apps/mission-control-next/src/cockpit/areas"),findings=[];
 async function walk(dir){for(const item of await fs.promises.readdir(dir,{withFileTypes:true})){const file=path.join(dir,item.name);if(item.isDirectory())await walk(file);else if(/\.tsx?$/u.test(item.name)&&!item.name.includes(".test."))findings.push(...findClassicWorkflowDependencies(file,await fs.promises.readFile(file,"utf8")));}}
 await walk(start);
 const adapter=path.join(root,"apps/mission-control-next/src/cockpit/ui/NativeOwnerLink.tsx");
 findings.push(...findClassicWorkflowDependencies(adapter,await fs.promises.readFile(adapter,"utf8")));
 return findings;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const findings=await checkCockpitWorkflowDependencies();
 for(const item of findings)console.error(`${item.file}:${item.line}: ${item.reason}`);
 if(findings.length)process.exitCode=1;else console.log("Cockpit required workflow dependency guard passed; explicit shell rollback remains allowed outside feature areas.");
}
