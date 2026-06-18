export type UiActionState = "idle" | "pending" | "success" | "error";

export type IntegrationFieldType = "text" | "password" | "textarea" | "number" | "boolean" | "select" | "url" | "json";

export interface IntegrationFieldOption {
  value: string;
  label: string;
  hint?: string;
}

export interface IntegrationFieldSchema {
  key: string;
  label: string;
  type: IntegrationFieldType;
  required?: boolean;
  description?: string;
  placeholder?: string;
  defaultValue?: unknown;
  options?: IntegrationFieldOption[];
  advanced?: boolean;
  secretRef?: boolean;
}

export interface IntegrationFormSchema {
  catalogId: string;
  title: string;
  description?: string;
  allowAdvancedJson?: boolean;
  fields: IntegrationFieldSchema[];
}
