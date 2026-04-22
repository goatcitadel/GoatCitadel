declare module "monaco-editor/esm/vs/editor/editor.api" {
  export * from "monaco-editor";
}

declare module "monaco-editor/esm/vs/language/css/monaco.contribution" {
  const cssContribution: unknown;
  export default cssContribution;
}

declare module "monaco-editor/esm/vs/language/html/monaco.contribution" {
  const htmlContribution: unknown;
  export default htmlContribution;
}

declare module "monaco-editor/esm/vs/language/json/monaco.contribution" {
  const jsonContribution: unknown;
  export default jsonContribution;
}

declare module "monaco-editor/esm/vs/language/typescript/monaco.contribution" {
  const tsContribution: unknown;
  export default tsContribution;
}

declare module "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution" {
  const markdownContribution: unknown;
  export default markdownContribution;
}

declare module "monaco-editor/esm/vs/basic-languages/shell/shell.contribution" {
  const shellContribution: unknown;
  export default shellContribution;
}

declare module "monaco-editor/esm/vs/basic-languages/xml/xml.contribution" {
  const xmlContribution: unknown;
  export default xmlContribution;
}

declare module "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution" {
  const yamlContribution: unknown;
  export default yamlContribution;
}
