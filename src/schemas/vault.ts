import { z } from "zod";

export const vaultInitSchema = z
  .object({
    password: z.string().trim().min(6, "master_password_too_short"),
    confirm_password: z.string().trim().min(6, "master_password_too_short"),
  })
  .superRefine((values, context) => {
    if (values.password !== values.confirm_password) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "password_mismatch",
        path: ["confirm_password"],
      });
    }
  });

export const vaultUnlockSchema = z.object({
  password: z.string().trim().optional().default(""),
});

export const vaultRecoverySchema = z.object({
  password: z.string().trim().min(1, "master_password_required"),
});

export const vaultForgotConfirmSchema = z.object({
  confirm: z.string().trim().min(1, "invalid_input"),
});

export type VaultInitInput = z.input<typeof vaultInitSchema>;
export type VaultInitValues = z.output<typeof vaultInitSchema>;
export type VaultUnlockInput = z.input<typeof vaultUnlockSchema>;
export type VaultUnlockValues = z.output<typeof vaultUnlockSchema>;
export type VaultRecoveryInput = z.input<typeof vaultRecoverySchema>;
export type VaultRecoveryValues = z.output<typeof vaultRecoverySchema>;
export type VaultForgotConfirmInput = z.input<typeof vaultForgotConfirmSchema>;
export type VaultForgotConfirmValues = z.output<typeof vaultForgotConfirmSchema>;
