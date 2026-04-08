import { z } from 'zod'

export const ContextSchema = z.object({
  claude_md_summary: z.string().optional(),
  claude_md_hash: z.string().optional(),
  repo: z.object({
    root: z.string(),
    branch: z.string(),
    remote: z.string().optional(),
  }).optional(),
  manifest: z.object({
    type: z.string(),
    name: z.string(),
    key_deps: z.array(z.string()),
  }).optional(),
}).default({})

export const RegisterInput = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  working_dir: z.string(),
  context: ContextSchema,
})

export const StatusInput = z.object({
  agent_id: z.string(),
  status: z.string(),
})

export const TouchInput = z.object({ agent_id: z.string() })

export const DescribeInput = z.object({ agent: z.string() })

export const SendInput = z.object({
  to: z.string().min(1),
  kind: z.enum(['note', 'request', 'question']),
  body: z.string().min(1),
  priority: z.enum(['normal', 'high']).default('normal'),
})

export const ReadInput = z.object({ agent_id: z.string() })

export const LogInput = z.object({
  agent_id: z.string(),
  entry: z.string().min(1),
})

export const LogReadInput = z.object({
  since: z.string().optional(),
})

export const DeregisterInput = z.object({ agent_id: z.string() })
