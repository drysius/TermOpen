import { z } from "zod";

export const settingsSchema = z.object({
  preferred_editor: z.enum(["internal", "vscode", "system"]),
  external_editor_command: z.string().optional().default(""),
  sync_auto_enabled: z.boolean(),
  sync_on_startup: z.boolean(),
  sync_on_settings_change: z.boolean(),
  sync_interval_minutes: z.number().int().min(1, "invalid_input").max(60, "invalid_input"),
  sftp_chunk_size_kb: z.number().int().min(64, "invalid_input").max(8192, "invalid_input"),
  sftp_reconnect_delay_seconds: z.number().int().min(1, "invalid_input").max(120, "invalid_input"),
  inactivity_lock_minutes: z.number().int().min(1, "invalid_input").max(240, "invalid_input"),
  auto_reconnect_enabled: z.boolean(),
  reconnect_delay_seconds: z.number().int().min(1, "invalid_input").max(120, "invalid_input"),
  terminal_copy_on_select: z.boolean(),
  terminal_right_click_paste: z.boolean(),
  terminal_ctrl_shift_shortcuts: z.boolean(),
  debug_logs_enabled: z.boolean(),
  modified_files_upload_policy: z.enum(["auto", "ask", "manual"]),
  known_hosts_path: z.string().optional().default(""),
  selected_auth_server_id: z.string().nullable().optional(),
});

export const changePasswordSchema = z
  .object({
    oldPassword: z.string().optional().default(""),
    newPassword: z.string().trim().min(6, "master_password_too_short"),
    confirmPassword: z.string().trim().min(1, "invalid_input"),
  })
  .superRefine((values, context) => {
    if (values.newPassword !== values.confirmPassword) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "password_mismatch",
        path: ["confirmPassword"],
      });
    }
  });

export const deleteAccountSchema = z.object({
  currentPassword: z.string().trim().min(1, "master_password_required"),
  deleteCloudData: z.boolean(),
});

export const localServerSchema = z.object({
  id: z.string().optional().default(""),
  label: z.string().trim().min(1, "invalid_input"),
  address: z
    .string()
    .trim()
    .min(1, "invalid_input")
    .refine((value) => value.startsWith("http://") || value.startsWith("https://"), "invalid_input"),
  author: z.string().optional().default(""),
});

export type SettingsSchemaInput = z.input<typeof settingsSchema>;
export type SettingsSchemaValues = z.output<typeof settingsSchema>;
export type ChangePasswordSchemaInput = z.input<typeof changePasswordSchema>;
export type ChangePasswordSchemaValues = z.output<typeof changePasswordSchema>;
export type DeleteAccountSchemaInput = z.input<typeof deleteAccountSchema>;
export type DeleteAccountSchemaValues = z.output<typeof deleteAccountSchema>;
export type LocalServerSchemaInput = z.input<typeof localServerSchema>;
export type LocalServerSchemaValues = z.output<typeof localServerSchema>;
