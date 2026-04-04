import { z } from "zod";

export const keychainSchema = z
  .object({
    id: z.string().optional().default(""),
    name: z.string().trim().min(1, "keychain_name_required"),
    entry_type: z.enum(["password", "ssh_key", "secret"]),
    password: z.string().optional().default(""),
    passphrase: z.string().optional().default(""),
    private_key: z.string().optional().default(""),
    public_key: z.string().optional().default(""),
  })
  .superRefine((values, context) => {
    const password = values.password?.trim();
    const privateKey = values.private_key?.trim();
    const publicKey = values.public_key?.trim();
    if (!password && !privateKey && !publicKey) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "keychain_credential_required",
      });
    }
  });

export type KeychainSchemaInput = z.input<typeof keychainSchema>;
export type KeychainSchemaValues = z.output<typeof keychainSchema>;
