import { z } from "zod";

export const workspaceNameInputSchema = z.object({
  value: z.string().trim().min(1, "invalid_input"),
});

export const workspaceConfirmSchema = z.object({
  confirmed: z.literal(true),
});

export const workspacePasswordSchema = z.object({
  password: z.string().trim().min(1, "master_password_required"),
  save: z.boolean().default(false),
});

export type WorkspaceNameInputValues = z.output<typeof workspaceNameInputSchema>;
export type WorkspaceConfirmValues = z.output<typeof workspaceConfirmSchema>;
export type WorkspacePasswordInput = z.input<typeof workspacePasswordSchema>;
export type WorkspacePasswordValues = z.output<typeof workspacePasswordSchema>;
