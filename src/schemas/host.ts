import { z } from "zod";

export const hostFormSchema = z.object({
  id: z.string().optional().default(""),
  name: z.string().trim().min(1, "invalid_input"),
  protocols: z.array(z.enum(["ssh", "sftp", "ftp", "ftps", "smb", "rdp"])).min(1, "invalid_input"),
  host: z.string().trim().min(1, "invalid_input"),
  port: z.number().int().min(1, "invalid_input").max(65535, "invalid_input"),
  username: z.string().trim().min(1, "invalid_input"),
  password: z.string().optional().default(""),
  private_key: z.string().optional().default(""),
  keychain_id: z.string().optional().default(""),
  remote_path: z.string().optional().default("/"),
});

export type HostFormSchemaInput = z.input<typeof hostFormSchema>;
export type HostFormSchemaValues = z.output<typeof hostFormSchema>;
