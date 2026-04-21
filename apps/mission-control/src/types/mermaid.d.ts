declare module "mermaid" {
  interface MermaidApi {
    initialize(config: Record<string, unknown>): void;
    render(id: string, text: string): Promise<{ svg: string }>;
  }

  const mermaid: MermaidApi;
  export default mermaid;
}
