import { z } from "zod";

export const importKeySchema = z
  .object({
    method: z.enum(["manual", "file", "paste", "generate"]),
    name: z.string().trim().min(1, "invalid_input"),
    passphrase: z.string().optional().default(""),
    rawKey: z.string().optional().default(""),
    manualType: z.enum(["password", "ssh_key", "secret"]).optional().default("password"),
    manualPassword: z.string().optional().default(""),
    manualPrivateKey: z.string().optional().default(""),
    manualPublicKey: z.string().optional().default(""),
    algorithm: z.enum(["ed25519", "rsa4096", "rsa2048", "ecdsa521"]).optional().default("ed25519"),
    generateComment: z.string().optional().default(""),
  })
  .superRefine((values, context) => {
    if (values.method === "manual") {
      const password = values.manualPassword.trim();
      const privateKey = values.manualPrivateKey.trim();
      const publicKey = values.manualPublicKey.trim();
      if (values.manualType === "password" && !password) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "keychain_credential_required",
          path: ["manualPassword"],
        });
        return;
      }
      if (values.manualType === "ssh_key" && !privateKey && !publicKey) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "keychain_credential_required",
          path: ["manualPrivateKey"],
        });
        return;
      }
      if (values.manualType === "secret" && !password && !privateKey && !publicKey) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "keychain_credential_required",
          path: ["manualPassword"],
        });
      }
      return;
    }

    if ((values.method === "file" || values.method === "paste") && !values.rawKey.trim()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "invalid_input",
        path: ["rawKey"],
      });
    }
  });

export type ImportKeySchemaInput = z.input<typeof importKeySchema>;
export type ImportKeySchemaValues = z.output<typeof importKeySchema>;
