import type { AppSettings } from "@/types/termopen";

export interface SettingsFormValues extends AppSettings {}

export interface PasswordFormValues {
  oldPassword: string;
  newPassword: string;
  confirmPassword: string;
}

