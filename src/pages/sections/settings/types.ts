import type { AppSettings } from "@/types/openptl";

export interface SettingsFormValues extends AppSettings {}

export interface PasswordFormValues {
  oldPassword: string;
  newPassword: string;
  confirmPassword: string;
}

