export interface Project {
  id: string
  owner_id: string
  name: string
  description: string | null
  created_at: string
  updated_at: string
  last_opened_at: string | null
}
