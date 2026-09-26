export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      action_usage: {
        Row: {
          billable: boolean
          created_at: string
          id: string
          meter_version: number
          occurred_at: string
          quantity: number
          tool_name: string
          workspace_id: string
        }
        Insert: {
          billable: boolean
          created_at?: string
          id?: string
          meter_version?: number
          occurred_at?: string
          quantity?: number
          tool_name: string
          workspace_id: string
        }
        Update: {
          billable?: boolean
          created_at?: string
          id?: string
          meter_version?: number
          occurred_at?: string
          quantity?: number
          tool_name?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "action_usage_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "action_usage_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      action_usage_reservations: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          meter_version: number
          tool_name: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          id?: string
          meter_version: number
          tool_name: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          meter_version?: number
          tool_name?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "action_usage_reservations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "action_usage_reservations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      activity_log: {
        Row: {
          api_key_id: string | null
          created_at: string
          duration_ms: number | null
          error_code: string | null
          error_details: Json | null
          id: string
          inbox_id: string | null
          ip_address: unknown
          status: string
          tool_name: string
          user_agent: string | null
          workspace_id: string
        }
        Insert: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status: string
          tool_name: string
          user_agent?: string | null
          workspace_id: string
        }
        Update: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status?: string
          tool_name?: string
          user_agent?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "activity_log_api_key_id_fkey"
            columns: ["api_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_log_inbox_id_fkey"
            columns: ["inbox_id"]
            isOneToOne: false
            referencedRelation: "inboxes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_log_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "activity_log_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      activity_log_2026_05: {
        Row: {
          api_key_id: string | null
          created_at: string
          duration_ms: number | null
          error_code: string | null
          error_details: Json | null
          id: string
          inbox_id: string | null
          ip_address: unknown
          status: string
          tool_name: string
          user_agent: string | null
          workspace_id: string
        }
        Insert: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status: string
          tool_name: string
          user_agent?: string | null
          workspace_id: string
        }
        Update: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status?: string
          tool_name?: string
          user_agent?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      activity_log_2026_06: {
        Row: {
          api_key_id: string | null
          created_at: string
          duration_ms: number | null
          error_code: string | null
          error_details: Json | null
          id: string
          inbox_id: string | null
          ip_address: unknown
          status: string
          tool_name: string
          user_agent: string | null
          workspace_id: string
        }
        Insert: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status: string
          tool_name: string
          user_agent?: string | null
          workspace_id: string
        }
        Update: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status?: string
          tool_name?: string
          user_agent?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      activity_log_2026_07: {
        Row: {
          api_key_id: string | null
          created_at: string
          duration_ms: number | null
          error_code: string | null
          error_details: Json | null
          id: string
          inbox_id: string | null
          ip_address: unknown
          status: string
          tool_name: string
          user_agent: string | null
          workspace_id: string
        }
        Insert: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status: string
          tool_name: string
          user_agent?: string | null
          workspace_id: string
        }
        Update: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status?: string
          tool_name?: string
          user_agent?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      activity_log_2026_08: {
        Row: {
          api_key_id: string | null
          created_at: string
          duration_ms: number | null
          error_code: string | null
          error_details: Json | null
          id: string
          inbox_id: string | null
          ip_address: unknown
          status: string
          tool_name: string
          user_agent: string | null
          workspace_id: string
        }
        Insert: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status: string
          tool_name: string
          user_agent?: string | null
          workspace_id: string
        }
        Update: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status?: string
          tool_name?: string
          user_agent?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      activity_log_2026_09: {
        Row: {
          api_key_id: string | null
          created_at: string
          duration_ms: number | null
          error_code: string | null
          error_details: Json | null
          id: string
          inbox_id: string | null
          ip_address: unknown
          status: string
          tool_name: string
          user_agent: string | null
          workspace_id: string
        }
        Insert: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status: string
          tool_name: string
          user_agent?: string | null
          workspace_id: string
        }
        Update: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status?: string
          tool_name?: string
          user_agent?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      activity_log_2026_10: {
        Row: {
          api_key_id: string | null
          created_at: string
          duration_ms: number | null
          error_code: string | null
          error_details: Json | null
          id: string
          inbox_id: string | null
          ip_address: unknown
          status: string
          tool_name: string
          user_agent: string | null
          workspace_id: string
        }
        Insert: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status: string
          tool_name: string
          user_agent?: string | null
          workspace_id: string
        }
        Update: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status?: string
          tool_name?: string
          user_agent?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      activity_log_2026_11: {
        Row: {
          api_key_id: string | null
          created_at: string
          duration_ms: number | null
          error_code: string | null
          error_details: Json | null
          id: string
          inbox_id: string | null
          ip_address: unknown
          status: string
          tool_name: string
          user_agent: string | null
          workspace_id: string
        }
        Insert: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status: string
          tool_name: string
          user_agent?: string | null
          workspace_id: string
        }
        Update: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status?: string
          tool_name?: string
          user_agent?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      activity_log_2026_12: {
        Row: {
          api_key_id: string | null
          created_at: string
          duration_ms: number | null
          error_code: string | null
          error_details: Json | null
          id: string
          inbox_id: string | null
          ip_address: unknown
          status: string
          tool_name: string
          user_agent: string | null
          workspace_id: string
        }
        Insert: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status: string
          tool_name: string
          user_agent?: string | null
          workspace_id: string
        }
        Update: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status?: string
          tool_name?: string
          user_agent?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      activity_log_2027_01: {
        Row: {
          api_key_id: string | null
          created_at: string
          duration_ms: number | null
          error_code: string | null
          error_details: Json | null
          id: string
          inbox_id: string | null
          ip_address: unknown
          status: string
          tool_name: string
          user_agent: string | null
          workspace_id: string
        }
        Insert: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status: string
          tool_name: string
          user_agent?: string | null
          workspace_id: string
        }
        Update: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status?: string
          tool_name?: string
          user_agent?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      activity_log_2027_02: {
        Row: {
          api_key_id: string | null
          created_at: string
          duration_ms: number | null
          error_code: string | null
          error_details: Json | null
          id: string
          inbox_id: string | null
          ip_address: unknown
          status: string
          tool_name: string
          user_agent: string | null
          workspace_id: string
        }
        Insert: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status: string
          tool_name: string
          user_agent?: string | null
          workspace_id: string
        }
        Update: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status?: string
          tool_name?: string
          user_agent?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      activity_log_2027_03: {
        Row: {
          api_key_id: string | null
          created_at: string
          duration_ms: number | null
          error_code: string | null
          error_details: Json | null
          id: string
          inbox_id: string | null
          ip_address: unknown
          status: string
          tool_name: string
          user_agent: string | null
          workspace_id: string
        }
        Insert: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status: string
          tool_name: string
          user_agent?: string | null
          workspace_id: string
        }
        Update: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status?: string
          tool_name?: string
          user_agent?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      activity_log_2027_04: {
        Row: {
          api_key_id: string | null
          created_at: string
          duration_ms: number | null
          error_code: string | null
          error_details: Json | null
          id: string
          inbox_id: string | null
          ip_address: unknown
          status: string
          tool_name: string
          user_agent: string | null
          workspace_id: string
        }
        Insert: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status: string
          tool_name: string
          user_agent?: string | null
          workspace_id: string
        }
        Update: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status?: string
          tool_name?: string
          user_agent?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      activity_log_2027_05: {
        Row: {
          api_key_id: string | null
          created_at: string
          duration_ms: number | null
          error_code: string | null
          error_details: Json | null
          id: string
          inbox_id: string | null
          ip_address: unknown
          status: string
          tool_name: string
          user_agent: string | null
          workspace_id: string
        }
        Insert: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status: string
          tool_name: string
          user_agent?: string | null
          workspace_id: string
        }
        Update: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status?: string
          tool_name?: string
          user_agent?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      activity_log_2027_06: {
        Row: {
          api_key_id: string | null
          created_at: string
          duration_ms: number | null
          error_code: string | null
          error_details: Json | null
          id: string
          inbox_id: string | null
          ip_address: unknown
          status: string
          tool_name: string
          user_agent: string | null
          workspace_id: string
        }
        Insert: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status: string
          tool_name: string
          user_agent?: string | null
          workspace_id: string
        }
        Update: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status?: string
          tool_name?: string
          user_agent?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      activity_log_2027_07: {
        Row: {
          api_key_id: string | null
          created_at: string
          duration_ms: number | null
          error_code: string | null
          error_details: Json | null
          id: string
          inbox_id: string | null
          ip_address: unknown
          status: string
          tool_name: string
          user_agent: string | null
          workspace_id: string
        }
        Insert: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status: string
          tool_name: string
          user_agent?: string | null
          workspace_id: string
        }
        Update: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status?: string
          tool_name?: string
          user_agent?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      activity_log_2027_08: {
        Row: {
          api_key_id: string | null
          created_at: string
          duration_ms: number | null
          error_code: string | null
          error_details: Json | null
          id: string
          inbox_id: string | null
          ip_address: unknown
          status: string
          tool_name: string
          user_agent: string | null
          workspace_id: string
        }
        Insert: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status: string
          tool_name: string
          user_agent?: string | null
          workspace_id: string
        }
        Update: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status?: string
          tool_name?: string
          user_agent?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      activity_log_2027_09: {
        Row: {
          api_key_id: string | null
          created_at: string
          duration_ms: number | null
          error_code: string | null
          error_details: Json | null
          id: string
          inbox_id: string | null
          ip_address: unknown
          status: string
          tool_name: string
          user_agent: string | null
          workspace_id: string
        }
        Insert: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status: string
          tool_name: string
          user_agent?: string | null
          workspace_id: string
        }
        Update: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status?: string
          tool_name?: string
          user_agent?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      activity_log_2027_10: {
        Row: {
          api_key_id: string | null
          created_at: string
          duration_ms: number | null
          error_code: string | null
          error_details: Json | null
          id: string
          inbox_id: string | null
          ip_address: unknown
          status: string
          tool_name: string
          user_agent: string | null
          workspace_id: string
        }
        Insert: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status: string
          tool_name: string
          user_agent?: string | null
          workspace_id: string
        }
        Update: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status?: string
          tool_name?: string
          user_agent?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      activity_log_2027_11: {
        Row: {
          api_key_id: string | null
          created_at: string
          duration_ms: number | null
          error_code: string | null
          error_details: Json | null
          id: string
          inbox_id: string | null
          ip_address: unknown
          status: string
          tool_name: string
          user_agent: string | null
          workspace_id: string
        }
        Insert: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status: string
          tool_name: string
          user_agent?: string | null
          workspace_id: string
        }
        Update: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status?: string
          tool_name?: string
          user_agent?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      activity_log_2027_12: {
        Row: {
          api_key_id: string | null
          created_at: string
          duration_ms: number | null
          error_code: string | null
          error_details: Json | null
          id: string
          inbox_id: string | null
          ip_address: unknown
          status: string
          tool_name: string
          user_agent: string | null
          workspace_id: string
        }
        Insert: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status: string
          tool_name: string
          user_agent?: string | null
          workspace_id: string
        }
        Update: {
          api_key_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          error_details?: Json | null
          id?: string
          inbox_id?: string | null
          ip_address?: unknown
          status?: string
          tool_name?: string
          user_agent?: string | null
          workspace_id?: string
        }
        Relationships: []
      }
      admin_oauth_cap_snapshots: {
        Row: {
          google_reported_users: number
          id: number
          note: string | null
          provider: string
          recorded_at: string
        }
        Insert: {
          google_reported_users: number
          id?: never
          note?: string | null
          provider: string
          recorded_at?: string
        }
        Update: {
          google_reported_users?: number
          id?: never
          note?: string | null
          provider?: string
          recorded_at?: string
        }
        Relationships: []
      }
      api_keys: {
        Row: {
          card_build_notified: string | null
          created_at: string
          created_by: string | null
          deleted_at: string | null
          expires_at: string | null
          id: string
          inbox_ids: string[] | null
          key_hash: string
          key_prefix: string
          last_used_at: string | null
          name: string
          scopes: string[]
          updated_at: string
          workspace_id: string
        }
        Insert: {
          card_build_notified?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          expires_at?: string | null
          id?: string
          inbox_ids?: string[] | null
          key_hash: string
          key_prefix: string
          last_used_at?: string | null
          name: string
          scopes?: string[]
          updated_at?: string
          workspace_id: string
        }
        Update: {
          card_build_notified?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          expires_at?: string | null
          id?: string
          inbox_ids?: string[] | null
          key_hash?: string
          key_prefix?: string
          last_used_at?: string | null
          name?: string
          scopes?: string[]
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_keys_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "api_keys_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "api_keys_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      app_errors: {
        Row: {
          context: Json
          created_at: string
          id: string
          message: string
          resolved_at: string | null
          severity: string
          stack: string | null
        }
        Insert: {
          context?: Json
          created_at?: string
          id?: string
          message: string
          resolved_at?: string | null
          severity?: string
          stack?: string | null
        }
        Update: {
          context?: Json
          created_at?: string
          id?: string
          message?: string
          resolved_at?: string | null
          severity?: string
          stack?: string | null
        }
        Relationships: []
      }
      auth_logs: {
        Row: {
          created_at: string
          event_type: string
          id: string
          ip_address: unknown
          metadata: Json | null
          provider: string | null
          user_agent: string | null
          user_id: string | null
          workspace_id: string | null
        }
        Insert: {
          created_at?: string
          event_type: string
          id?: string
          ip_address?: unknown
          metadata?: Json | null
          provider?: string | null
          user_agent?: string | null
          user_id?: string | null
          workspace_id?: string | null
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: string
          ip_address?: unknown
          metadata?: Json | null
          provider?: string | null
          user_agent?: string | null
          user_id?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "auth_logs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "auth_logs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "auth_logs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_email_sends: {
        Row: {
          attempts: number
          cancel_reason: string | null
          cancelled_at: string | null
          category: string | null
          claimed_at: string | null
          created_at: string
          id: number
          last_error: string | null
          payload: Json
          period_start: string | null
          recipient: string
          resend_id: string | null
          scope_key: string
          send_after: string
          sent_at: string | null
          stripe_customer_id: string | null
          template: string
          updated_at: string
          user_id: string | null
          workspace_id: string | null
        }
        Insert: {
          attempts?: number
          cancel_reason?: string | null
          cancelled_at?: string | null
          category?: string | null
          claimed_at?: string | null
          created_at?: string
          id?: never
          last_error?: string | null
          payload?: Json
          period_start?: string | null
          recipient: string
          resend_id?: string | null
          scope_key: string
          send_after: string
          sent_at?: string | null
          stripe_customer_id?: string | null
          template: string
          updated_at?: string
          user_id?: string | null
          workspace_id?: string | null
        }
        Update: {
          attempts?: number
          cancel_reason?: string | null
          cancelled_at?: string | null
          category?: string | null
          claimed_at?: string | null
          created_at?: string
          id?: never
          last_error?: string | null
          payload?: Json
          period_start?: string | null
          recipient?: string
          resend_id?: string | null
          scope_key?: string
          send_after?: string
          sent_at?: string | null
          stripe_customer_id?: string | null
          template?: string
          updated_at?: string
          user_id?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "billing_email_sends_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_email_sends_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "billing_email_sends_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      bulk_plans: {
        Row: {
          action: string
          affected_count: number | null
          api_key_id: string | null
          cancelled_at: string | null
          cancelled_by_api_key_id: string | null
          created_at: string
          error_code: string | null
          executed_at: string | null
          executed_by_api_key_id: string | null
          expires_at: string
          id: string
          inbox_id: string
          match_count: number
          operation: string
          permanent: boolean
          scope: Json
          scope_encrypted: boolean
          scope_kind: string
          status: string
          workspace_id: string
        }
        Insert: {
          action: string
          affected_count?: number | null
          api_key_id?: string | null
          cancelled_at?: string | null
          cancelled_by_api_key_id?: string | null
          created_at?: string
          error_code?: string | null
          executed_at?: string | null
          executed_by_api_key_id?: string | null
          expires_at: string
          id?: string
          inbox_id: string
          match_count: number
          operation: string
          permanent?: boolean
          scope: Json
          scope_encrypted?: boolean
          scope_kind: string
          status?: string
          workspace_id: string
        }
        Update: {
          action?: string
          affected_count?: number | null
          api_key_id?: string | null
          cancelled_at?: string | null
          cancelled_by_api_key_id?: string | null
          created_at?: string
          error_code?: string | null
          executed_at?: string | null
          executed_by_api_key_id?: string | null
          expires_at?: string
          id?: string
          inbox_id?: string
          match_count?: number
          operation?: string
          permanent?: boolean
          scope?: Json
          scope_encrypted?: boolean
          scope_kind?: string
          status?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bulk_plans_api_key_id_fkey"
            columns: ["api_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bulk_plans_cancelled_by_api_key_id_fkey"
            columns: ["cancelled_by_api_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bulk_plans_executed_by_api_key_id_fkey"
            columns: ["executed_by_api_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bulk_plans_inbox_id_fkey"
            columns: ["inbox_id"]
            isOneToOne: false
            referencedRelation: "inboxes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bulk_plans_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "bulk_plans_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      bulk_runs: {
        Row: {
          api_key_id: string | null
          cancel_requested_at: string | null
          completed_at: string | null
          created_at: string
          error_code: string | null
          failed: number
          id: string
          inbox_id: string
          operation: string
          processed: number
          status: string
          succeeded: number
          total: number
          updated_at: string
          workspace_id: string
        }
        Insert: {
          api_key_id?: string | null
          cancel_requested_at?: string | null
          completed_at?: string | null
          created_at?: string
          error_code?: string | null
          failed?: number
          id?: string
          inbox_id: string
          operation: string
          processed?: number
          status?: string
          succeeded?: number
          total: number
          updated_at?: string
          workspace_id: string
        }
        Update: {
          api_key_id?: string | null
          cancel_requested_at?: string | null
          completed_at?: string | null
          created_at?: string
          error_code?: string | null
          failed?: number
          id?: string
          inbox_id?: string
          operation?: string
          processed?: number
          status?: string
          succeeded?: number
          total?: number
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bulk_runs_api_key_id_fkey"
            columns: ["api_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bulk_runs_inbox_id_fkey"
            columns: ["inbox_id"]
            isOneToOne: false
            referencedRelation: "inboxes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bulk_runs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "bulk_runs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      experiment_assignments: {
        Row: {
          experiment_key: string
          first_assigned_at: string
          subject_id: string
          variant_id: string
        }
        Insert: {
          experiment_key: string
          first_assigned_at?: string
          subject_id: string
          variant_id: string
        }
        Update: {
          experiment_key?: string
          first_assigned_at?: string
          subject_id?: string
          variant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "experiment_assignments_experiment_key_fkey"
            columns: ["experiment_key"]
            isOneToOne: false
            referencedRelation: "experiments"
            referencedColumns: ["key"]
          },
        ]
      }
      experiment_subjects: {
        Row: {
          linked_at: string
          subject_id: string
          user_id: string | null
          workspace_id: string | null
        }
        Insert: {
          linked_at?: string
          subject_id: string
          user_id?: string | null
          workspace_id?: string | null
        }
        Update: {
          linked_at?: string
          subject_id?: string
          user_id?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "experiment_subjects_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "experiment_subjects_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      experiments: {
        Row: {
          concluded_at: string | null
          created_at: string
          description: string | null
          key: string
          name: string
          retention_goal: string
          retention_window_days: number
          started_at: string | null
          status: string
          updated_at: string
          variants: Json
          winner_variant_id: string | null
        }
        Insert: {
          concluded_at?: string | null
          created_at?: string
          description?: string | null
          key: string
          name: string
          retention_goal?: string
          retention_window_days?: number
          started_at?: string | null
          status?: string
          updated_at?: string
          variants: Json
          winner_variant_id?: string | null
        }
        Update: {
          concluded_at?: string | null
          created_at?: string
          description?: string | null
          key?: string
          name?: string
          retention_goal?: string
          retention_window_days?: number
          started_at?: string | null
          status?: string
          updated_at?: string
          variants?: Json
          winner_variant_id?: string | null
        }
        Relationships: []
      }
      inbox_grandfather_revocations_20260901: {
        Row: {
          distinct_addresses_ever: number
          entitlement_kind: string
          had_multiple_before: boolean
          live_inboxes: number
          revoked_at: string
          user_id: string
        }
        Insert: {
          distinct_addresses_ever: number
          entitlement_kind: string
          had_multiple_before: boolean
          live_inboxes: number
          revoked_at?: string
          user_id: string
        }
        Update: {
          distinct_addresses_ever?: number
          entitlement_kind?: string
          had_multiple_before?: boolean
          live_inboxes?: number
          revoked_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "inbox_grandfather_revocations_20260901_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      inboxes: {
        Row: {
          bulk_review_mode: string
          created_at: string
          deleted_at: string | null
          display_name: string | null
          draft_editor_hidden: boolean
          email_address: string
          id: string
          imap_host: string | null
          imap_password: string | null
          imap_port: number | null
          imap_security: string
          imap_tls: boolean
          imap_username: string | null
          last_error: string | null
          last_sync_at: string | null
          oauth_access_token: string | null
          oauth_refresh_token: string | null
          oauth_scope: string | null
          oauth_token_expires_at: string | null
          provider: string
          send_approval_required: boolean
          send_review_mode: string
          service: string | null
          signature_enabled: boolean
          signature_html: string | null
          signature_reply_mode: string
          signature_source: string | null
          signature_text: string | null
          signature_updated_at: string | null
          smtp_host: string | null
          smtp_port: number | null
          smtp_security: string
          smtp_tls: boolean
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          bulk_review_mode?: string
          created_at?: string
          deleted_at?: string | null
          display_name?: string | null
          draft_editor_hidden?: boolean
          email_address: string
          id?: string
          imap_host?: string | null
          imap_password?: string | null
          imap_port?: number | null
          imap_security?: string
          imap_tls?: boolean
          imap_username?: string | null
          last_error?: string | null
          last_sync_at?: string | null
          oauth_access_token?: string | null
          oauth_refresh_token?: string | null
          oauth_scope?: string | null
          oauth_token_expires_at?: string | null
          provider: string
          send_approval_required?: boolean
          send_review_mode?: string
          service?: string | null
          signature_enabled?: boolean
          signature_html?: string | null
          signature_reply_mode?: string
          signature_source?: string | null
          signature_text?: string | null
          signature_updated_at?: string | null
          smtp_host?: string | null
          smtp_port?: number | null
          smtp_security?: string
          smtp_tls?: boolean
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          bulk_review_mode?: string
          created_at?: string
          deleted_at?: string | null
          display_name?: string | null
          draft_editor_hidden?: boolean
          email_address?: string
          id?: string
          imap_host?: string | null
          imap_password?: string | null
          imap_port?: number | null
          imap_security?: string
          imap_tls?: boolean
          imap_username?: string | null
          last_error?: string | null
          last_sync_at?: string | null
          oauth_access_token?: string | null
          oauth_refresh_token?: string | null
          oauth_scope?: string | null
          oauth_token_expires_at?: string | null
          provider?: string
          send_approval_required?: boolean
          send_review_mode?: string
          service?: string | null
          signature_enabled?: boolean
          signature_html?: string | null
          signature_reply_mode?: string
          signature_source?: string | null
          signature_text?: string | null
          signature_updated_at?: string | null
          smtp_host?: string | null
          smtp_port?: number | null
          smtp_security?: string
          smtp_tls?: boolean
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "inboxes_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "inboxes_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      internal_accounts: {
        Row: {
          added_at: string
          email: string
          note: string | null
        }
        Insert: {
          added_at?: string
          email: string
          note?: string | null
        }
        Update: {
          added_at?: string
          email?: string
          note?: string | null
        }
        Relationships: []
      }
      lifecycle_email_sends: {
        Row: {
          detail: string | null
          email: string
          provider_message_id: string | null
          sent_at: string
          status: string
          template: string
          trigger_key: string
          user_id: string
        }
        Insert: {
          detail?: string | null
          email: string
          provider_message_id?: string | null
          sent_at?: string
          status?: string
          template: string
          trigger_key: string
          user_id: string
        }
        Update: {
          detail?: string | null
          email?: string
          provider_message_id?: string | null
          sent_at?: string
          status?: string
          template?: string
          trigger_key?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lifecycle_email_sends_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      mcp_client_capabilities: {
        Row: {
          api_key_id: string
          capabilities: Json
          client_name: string
          client_version: string
          first_seen: string
          id: string
          last_seen: string
          protocol_version: string
          supports_ui: boolean
          workspace_id: string
        }
        Insert: {
          api_key_id: string
          capabilities?: Json
          client_name?: string
          client_version?: string
          first_seen?: string
          id?: string
          last_seen?: string
          protocol_version?: string
          supports_ui?: boolean
          workspace_id: string
        }
        Update: {
          api_key_id?: string
          capabilities?: Json
          client_name?: string
          client_version?: string
          first_seen?: string
          id?: string
          last_seen?: string
          protocol_version?: string
          supports_ui?: boolean
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "mcp_client_capabilities_api_key_id_fkey"
            columns: ["api_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mcp_client_capabilities_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "mcp_client_capabilities_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      oauth_auth_codes: {
        Row: {
          client_id: string
          client_name: string
          code_challenge: string
          code_challenge_method: string
          code_hash: string
          created_at: string
          expires_at: string
          id: string
          inbox_ids: string[] | null
          redirect_uri: string
          resource: string | null
          scopes: string[]
          user_id: string
          workspace_id: string
        }
        Insert: {
          client_id: string
          client_name: string
          code_challenge: string
          code_challenge_method?: string
          code_hash: string
          created_at?: string
          expires_at?: string
          id?: string
          inbox_ids?: string[] | null
          redirect_uri: string
          resource?: string | null
          scopes?: string[]
          user_id: string
          workspace_id: string
        }
        Update: {
          client_id?: string
          client_name?: string
          code_challenge?: string
          code_challenge_method?: string
          code_hash?: string
          created_at?: string
          expires_at?: string
          id?: string
          inbox_ids?: string[] | null
          redirect_uri?: string
          resource?: string | null
          scopes?: string[]
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "oauth_auth_codes_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "oauth_auth_codes_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      oauth_clients: {
        Row: {
          client_byline: string
          client_id: string
          client_name: string
          created_at: string
          deactivated_at: string | null
          id: string
          is_first_party: boolean
          logo_url: string | null
          redirect_uris: string[]
          scopes_allowed: string[]
          updated_at: string
        }
        Insert: {
          client_byline?: string
          client_id: string
          client_name: string
          created_at?: string
          deactivated_at?: string | null
          id?: string
          is_first_party?: boolean
          logo_url?: string | null
          redirect_uris?: string[]
          scopes_allowed?: string[]
          updated_at?: string
        }
        Update: {
          client_byline?: string
          client_id?: string
          client_name?: string
          created_at?: string
          deactivated_at?: string | null
          id?: string
          is_first_party?: boolean
          logo_url?: string | null
          redirect_uris?: string[]
          scopes_allowed?: string[]
          updated_at?: string
        }
        Relationships: []
      }
      oauth_consents: {
        Row: {
          client_id: string
          granted_at: string
          id: string
          inbox_ids: string[] | null
          scopes: string[]
          user_id: string
        }
        Insert: {
          client_id: string
          granted_at?: string
          id?: string
          inbox_ids?: string[] | null
          scopes?: string[]
          user_id: string
        }
        Update: {
          client_id?: string
          granted_at?: string
          id?: string
          inbox_ids?: string[] | null
          scopes?: string[]
          user_id?: string
        }
        Relationships: []
      }
      oauth_csrf_tokens: {
        Row: {
          consumed_at: string | null
          expires_at: string
          id: string
          token_hash: string
          user_id: string
        }
        Insert: {
          consumed_at?: string | null
          expires_at: string
          id?: string
          token_hash: string
          user_id: string
        }
        Update: {
          consumed_at?: string | null
          expires_at?: string
          id?: string
          token_hash?: string
          user_id?: string
        }
        Relationships: []
      }
      oauth_refresh_tokens: {
        Row: {
          api_key_id: string | null
          client_id: string
          client_name: string
          created_at: string
          expires_at: string
          id: string
          inbox_ids: string[] | null
          refresh_hash: string
          resource: string | null
          revoked_at: string | null
          scopes: string[]
          user_id: string
          workspace_id: string
        }
        Insert: {
          api_key_id?: string | null
          client_id: string
          client_name: string
          created_at?: string
          expires_at: string
          id?: string
          inbox_ids?: string[] | null
          refresh_hash: string
          resource?: string | null
          revoked_at?: string | null
          scopes?: string[]
          user_id: string
          workspace_id: string
        }
        Update: {
          api_key_id?: string | null
          client_id?: string
          client_name?: string
          created_at?: string
          expires_at?: string
          id?: string
          inbox_ids?: string[] | null
          refresh_hash?: string
          resource?: string | null
          revoked_at?: string | null
          scopes?: string[]
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "oauth_refresh_tokens_api_key_id_fkey"
            columns: ["api_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "oauth_refresh_tokens_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "oauth_refresh_tokens_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      oauth_state_nonces: {
        Row: {
          consumed_at: string | null
          expires_at: string
          id: string
          session_id: string
          state_hash: string
        }
        Insert: {
          consumed_at?: string | null
          expires_at: string
          id?: string
          session_id: string
          state_hash: string
        }
        Update: {
          consumed_at?: string | null
          expires_at?: string
          id?: string
          session_id?: string
          state_hash?: string
        }
        Relationships: []
      }
      oauth_states: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          provider: string
          redirect_uri: string
          state: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string
          id?: string
          provider: string
          redirect_uri: string
          state: string
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          provider?: string
          redirect_uri?: string
          state?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "oauth_states_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "oauth_states_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "oauth_states_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      outbound_idempotency: {
        Row: {
          api_key_id: string
          approval_id: string | null
          completed_at: string | null
          created_at: string
          expires_at: string
          id: string
          key_digest: string
          operation: string
          request_digest: string
          result_snapshot: Json | null
          status: string
          updated_at: string
        }
        Insert: {
          api_key_id: string
          approval_id?: string | null
          completed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          key_digest: string
          operation: string
          request_digest: string
          result_snapshot?: Json | null
          status?: string
          updated_at?: string
        }
        Update: {
          api_key_id?: string
          approval_id?: string | null
          completed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          key_digest?: string
          operation?: string
          request_digest?: string
          result_snapshot?: Json | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "outbound_idempotency_api_key_id_fkey"
            columns: ["api_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outbound_idempotency_approval_id_fkey"
            columns: ["approval_id"]
            isOneToOne: false
            referencedRelation: "send_approvals"
            referencedColumns: ["id"]
          },
        ]
      }
      product_funnel_events: {
        Row: {
          auth_reason: string | null
          category: string
          connection_type: string | null
          error_category: string | null
          id: number
          occurred_at: string
          outcome: string
          phase: string | null
          stage: string
          workspace_id: string
        }
        Insert: {
          auth_reason?: string | null
          category: string
          connection_type?: string | null
          error_category?: string | null
          id?: never
          occurred_at?: string
          outcome: string
          phase?: string | null
          stage: string
          workspace_id: string
        }
        Update: {
          auth_reason?: string | null
          category?: string
          connection_type?: string | null
          error_category?: string | null
          id?: never
          occurred_at?: string
          outcome?: string
          phase?: string | null
          stage?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_funnel_events_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "product_funnel_events_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_limit_buckets: {
        Row: {
          count: number
          key: string
          window_start: string
        }
        Insert: {
          count?: number
          key: string
          window_start: string
        }
        Update: {
          count?: number
          key?: string
          window_start?: string
        }
        Relationships: []
      }
      scheduled_sends: {
        Row: {
          created_at: string
          error_detail: string | null
          id: string
          inbox_id: string
          payload: Json
          payload_encrypted: boolean
          send_at: string
          sent_at: string | null
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          error_detail?: string | null
          id?: string
          inbox_id: string
          payload: Json
          payload_encrypted?: boolean
          send_at: string
          sent_at?: string | null
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          error_detail?: string | null
          id?: string
          inbox_id?: string
          payload?: Json
          payload_encrypted?: boolean
          send_at?: string
          sent_at?: string | null
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "scheduled_sends_inbox_id_fkey"
            columns: ["inbox_id"]
            isOneToOne: false
            referencedRelation: "inboxes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_sends_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "scheduled_sends_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      send_approvals: {
        Row: {
          api_key_id: string | null
          created_at: string
          decided_at: string | null
          decided_by: string | null
          decided_by_api_key_id: string | null
          decided_via: string | null
          decision_note: string | null
          expires_at: string | null
          id: string
          inbox_id: string
          operation: string
          payload: Json
          payload_encrypted: boolean
          send_at: string | null
          status: string
          summary: Json
          workspace_id: string
        }
        Insert: {
          api_key_id?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decided_by_api_key_id?: string | null
          decided_via?: string | null
          decision_note?: string | null
          expires_at?: string | null
          id?: string
          inbox_id: string
          operation: string
          payload: Json
          payload_encrypted?: boolean
          send_at?: string | null
          status?: string
          summary?: Json
          workspace_id: string
        }
        Update: {
          api_key_id?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decided_by_api_key_id?: string | null
          decided_via?: string | null
          decision_note?: string | null
          expires_at?: string | null
          id?: string
          inbox_id?: string
          operation?: string
          payload?: Json
          payload_encrypted?: boolean
          send_at?: string | null
          status?: string
          summary?: Json
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "send_approvals_api_key_id_fkey"
            columns: ["api_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "send_approvals_decided_by_api_key_id_fkey"
            columns: ["decided_by_api_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "send_approvals_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "send_approvals_inbox_id_fkey"
            columns: ["inbox_id"]
            isOneToOne: false
            referencedRelation: "inboxes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "send_approvals_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "send_approvals_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      stripe_webhook_events: {
        Row: {
          event_created: string | null
          event_id: string
          event_type: string | null
          processed_at: string
          stripe_customer_id: string | null
        }
        Insert: {
          event_created?: string | null
          event_id: string
          event_type?: string | null
          processed_at?: string
          stripe_customer_id?: string | null
        }
        Update: {
          event_created?: string | null
          event_id?: string
          event_type?: string | null
          processed_at?: string
          stripe_customer_id?: string | null
        }
        Relationships: []
      }
      synthetic_monitor_incidents: {
        Row: {
          consecutive_failures: number
          created_at: string
          failed_step: string
          failure_class: string
          fingerprint: string
          first_failure_at: string
          id: string
          incident_alerted_at: string | null
          last_failure_at: string
          last_run_id: string | null
          recovery_alerted_at: string | null
          resolved_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          consecutive_failures?: number
          created_at?: string
          failed_step: string
          failure_class: string
          fingerprint: string
          first_failure_at?: string
          id?: string
          incident_alerted_at?: string | null
          last_failure_at?: string
          last_run_id?: string | null
          recovery_alerted_at?: string | null
          resolved_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          consecutive_failures?: number
          created_at?: string
          failed_step?: string
          failure_class?: string
          fingerprint?: string
          first_failure_at?: string
          id?: string
          incident_alerted_at?: string | null
          last_failure_at?: string
          last_run_id?: string | null
          recovery_alerted_at?: string | null
          resolved_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "synthetic_monitor_incidents_last_run_id_fkey"
            columns: ["last_run_id"]
            isOneToOne: false
            referencedRelation: "synthetic_monitor_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      synthetic_monitor_runs: {
        Row: {
          completed_at: string | null
          deployment_id: string | null
          diagnostics: Json
          duration_ms: number | null
          failed_step: string | null
          failure_class: string | null
          failure_fingerprint: string | null
          id: string
          mode: string
          started_at: string
          status: string
          steps: Json
        }
        Insert: {
          completed_at?: string | null
          deployment_id?: string | null
          diagnostics?: Json
          duration_ms?: number | null
          failed_step?: string | null
          failure_class?: string | null
          failure_fingerprint?: string | null
          id?: string
          mode: string
          started_at?: string
          status?: string
          steps?: Json
        }
        Update: {
          completed_at?: string | null
          deployment_id?: string | null
          diagnostics?: Json
          duration_ms?: number | null
          failed_step?: string | null
          failure_class?: string | null
          failure_fingerprint?: string | null
          id?: string
          mode?: string
          started_at?: string
          status?: string
          steps?: Json
        }
        Relationships: []
      }
      system_events: {
        Row: {
          created_at: string
          error: string | null
          event_type: string
          id: string
          payload: Json
          processed_at: string | null
          status: string
        }
        Insert: {
          created_at?: string
          error?: string | null
          event_type: string
          id?: string
          payload?: Json
          processed_at?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          error?: string | null
          event_type?: string
          id?: string
          payload?: Json
          processed_at?: string | null
          status?: string
        }
        Relationships: []
      }
      system_notify_threads: {
        Row: {
          event_type: string
          message_id: string
          updated_at: string
        }
        Insert: {
          event_type: string
          message_id: string
          updated_at?: string
        }
        Update: {
          event_type?: string
          message_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      triage_rules: {
        Row: {
          action: Json
          api_key_id: string
          consecutive_failures: number
          created_at: string
          created_by: string | null
          deleted_at: string | null
          disabled_reason: string | null
          enabled: boolean
          filter: Json
          id: string
          inbox_id: string
          interval_minutes: number
          last_run_at: string | null
          max_messages_per_run: number
          name: string
          next_run_at: string | null
          paused_reason: string | null
          paused_until: string | null
          running_since: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          action: Json
          api_key_id: string
          consecutive_failures?: number
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          disabled_reason?: string | null
          enabled?: boolean
          filter: Json
          id?: string
          inbox_id: string
          interval_minutes: number
          last_run_at?: string | null
          max_messages_per_run?: number
          name: string
          next_run_at?: string | null
          paused_reason?: string | null
          paused_until?: string | null
          running_since?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          action?: Json
          api_key_id?: string
          consecutive_failures?: number
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          disabled_reason?: string | null
          enabled?: boolean
          filter?: Json
          id?: string
          inbox_id?: string
          interval_minutes?: number
          last_run_at?: string | null
          max_messages_per_run?: number
          name?: string
          next_run_at?: string | null
          paused_reason?: string | null
          paused_until?: string | null
          running_since?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "triage_rules_api_key_id_fkey"
            columns: ["api_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "triage_rules_inbox_id_fkey"
            columns: ["inbox_id"]
            isOneToOne: false
            referencedRelation: "inboxes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "triage_rules_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "triage_rules_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      triage_run_items: {
        Row: {
          created_at: string
          detail: Json
          id: string
          message_digest: string
          outcome: string
          rule_id: string
          run_id: string
          sender_redacted: string | null
          subject_redacted: string | null
          undo_state: Json | null
          undone_at: string | null
        }
        Insert: {
          created_at?: string
          detail?: Json
          id?: string
          message_digest: string
          outcome: string
          rule_id: string
          run_id: string
          sender_redacted?: string | null
          subject_redacted?: string | null
          undo_state?: Json | null
          undone_at?: string | null
        }
        Update: {
          created_at?: string
          detail?: Json
          id?: string
          message_digest?: string
          outcome?: string
          rule_id?: string
          run_id?: string
          sender_redacted?: string | null
          subject_redacted?: string | null
          undo_state?: Json | null
          undone_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "triage_run_items_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "triage_rules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "triage_run_items_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "triage_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      triage_runs: {
        Row: {
          completed_at: string | null
          duration_ms: number | null
          error_code: string | null
          error_detail: string | null
          failed: number
          id: string
          matched: number
          processed: number
          rule_id: string
          skipped: number
          started_at: string
          status: string
          succeeded: number
          trigger: string
          workspace_id: string
        }
        Insert: {
          completed_at?: string | null
          duration_ms?: number | null
          error_code?: string | null
          error_detail?: string | null
          failed?: number
          id?: string
          matched?: number
          processed?: number
          rule_id: string
          skipped?: number
          started_at?: string
          status: string
          succeeded?: number
          trigger?: string
          workspace_id: string
        }
        Update: {
          completed_at?: string | null
          duration_ms?: number | null
          error_code?: string | null
          error_detail?: string | null
          failed?: number
          id?: string
          matched?: number
          processed?: number
          rule_id?: string
          skipped?: number
          started_at?: string
          status?: string
          succeeded?: number
          trigger?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "triage_runs_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "triage_rules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "triage_runs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "triage_runs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      triage_seen_messages: {
        Row: {
          first_seen_at: string
          message_digest: string
          rule_id: string
        }
        Insert: {
          first_seen_at?: string
          message_digest: string
          rule_id: string
        }
        Update: {
          first_seen_at?: string
          message_digest?: string
          rule_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "triage_seen_messages_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "triage_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      usage_limit_events: {
        Row: {
          cap: number
          created_at: string
          effective_plan: string
          id: string
          meter_version: number
          occurred_at: string
          used_actions: number
          workspace_id: string
        }
        Insert: {
          cap: number
          created_at?: string
          effective_plan: string
          id?: string
          meter_version?: number
          occurred_at?: string
          used_actions: number
          workspace_id: string
        }
        Update: {
          cap?: number
          created_at?: string
          effective_plan?: string
          id?: string
          meter_version?: number
          occurred_at?: string
          used_actions?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "usage_limit_events_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "usage_limit_events_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      user_billing: {
        Row: {
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          plan: string
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          subscription_status: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          plan?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          subscription_status?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          plan?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          subscription_status?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_billing_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      user_usage_entitlement_audit: {
        Row: {
          id: number
          occurred_at: string
          operation: string
          record: Json
          user_id: string
        }
        Insert: {
          id?: never
          occurred_at?: string
          operation: string
          record: Json
          user_id: string
        }
        Update: {
          id?: never
          occurred_at?: string
          operation?: string
          record?: Json
          user_id?: string
        }
        Relationships: []
      }
      user_usage_entitlements: {
        Row: {
          created_at: string
          expires_at: string | null
          granted_at: string
          granted_by: string | null
          kind: string
          reason: string
          source: string
          unlimited_inboxes: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          granted_at?: string
          granted_by?: string | null
          kind: string
          reason: string
          source: string
          unlimited_inboxes?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          granted_at?: string
          granted_by?: string | null
          kind?: string
          reason?: string
          source?: string
          unlimited_inboxes?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_usage_entitlements_granted_by_fkey"
            columns: ["granted_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_usage_entitlements_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          email: string
          id: string
          unsubscribe_token: string
          unsubscribed_at: string | null
          unsubscribed_categories: string[]
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          email: string
          id: string
          unsubscribe_token?: string
          unsubscribed_at?: string | null
          unsubscribed_categories?: string[]
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          email?: string
          id?: string
          unsubscribe_token?: string
          unsubscribed_at?: string | null
          unsubscribed_categories?: string[]
          updated_at?: string
        }
        Relationships: []
      }
      workspace_invites: {
        Row: {
          accepted_at: string | null
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string
          role: string
          token_hash: string
          workspace_id: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          email: string
          expires_at?: string
          id?: string
          invited_by: string
          role?: string
          token_hash: string
          workspace_id: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string
          role?: string
          token_hash?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_invites_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_invites_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "workspace_invites_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_members: {
        Row: {
          joined_at: string
          role: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          joined_at?: string
          role?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          joined_at?: string
          role?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_members_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "workspace_members_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_usage_exemptions: {
        Row: {
          created_at: string
          expires_at: string | null
          granted_at: string
          granted_by: string | null
          id: string
          reason: string
          revoke_reason: string | null
          revoked_at: string | null
          revoked_by: string | null
          ticket_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          granted_at?: string
          granted_by?: string | null
          id?: string
          reason: string
          revoke_reason?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          ticket_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          granted_at?: string
          granted_by?: string | null
          id?: string
          reason?: string
          revoke_reason?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          ticket_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_usage_exemptions_granted_by_fkey"
            columns: ["granted_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_usage_exemptions_revoked_by_fkey"
            columns: ["revoked_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_usage_exemptions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "workspace_usage_exemptions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          acquisition_landing: string | null
          acquisition_landing_path: string | null
          acquisition_locale: string | null
          acquisition_referrer: string | null
          acquisition_source: string | null
          acquisition_utm_campaign: string | null
          acquisition_utm_medium: string | null
          acquisition_utm_source: string | null
          analytics_first_credential_created_at: string | null
          analytics_first_credential_method: string | null
          analytics_first_inbox_connected_at: string | null
          analytics_first_inbox_provider: string | null
          analytics_first_tool_client: string | null
          analytics_first_tool_name: string | null
          analytics_first_tool_path: string | null
          analytics_first_tool_provider: string | null
          analytics_first_tool_reported_at: string | null
          analytics_first_tool_used_at: string | null
          card_diagnostics: boolean
          created_at: string
          deleted_at: string | null
          display_name: string
          draft_editor_enabled: boolean
          draft_editor_hidden: boolean
          free_action_cap_exempt: boolean
          grandfathered: boolean
          id: string
          onboarding_client: string | null
          onboarding_client_selected_at: string | null
          onboarding_connection_verified_at: string | null
          onboarding_credential_issued_at: string | null
          onboarding_inbox_connected_at: string | null
          onboarding_provider: string | null
          onboarding_stage: string
          onboarding_started_at: string | null
          onboarding_technical_activated_at: string | null
          onboarding_value_activated_at: string | null
          owner_id: string
          plan: string
          slug: string
          stripe_customer_id: string | null
          updated_at: string
        }
        Insert: {
          acquisition_landing?: string | null
          acquisition_landing_path?: string | null
          acquisition_locale?: string | null
          acquisition_referrer?: string | null
          acquisition_source?: string | null
          acquisition_utm_campaign?: string | null
          acquisition_utm_medium?: string | null
          acquisition_utm_source?: string | null
          analytics_first_credential_created_at?: string | null
          analytics_first_credential_method?: string | null
          analytics_first_inbox_connected_at?: string | null
          analytics_first_inbox_provider?: string | null
          analytics_first_tool_client?: string | null
          analytics_first_tool_name?: string | null
          analytics_first_tool_path?: string | null
          analytics_first_tool_provider?: string | null
          analytics_first_tool_reported_at?: string | null
          analytics_first_tool_used_at?: string | null
          card_diagnostics?: boolean
          created_at?: string
          deleted_at?: string | null
          display_name: string
          draft_editor_enabled?: boolean
          draft_editor_hidden?: boolean
          free_action_cap_exempt?: boolean
          grandfathered?: boolean
          id?: string
          onboarding_client?: string | null
          onboarding_client_selected_at?: string | null
          onboarding_connection_verified_at?: string | null
          onboarding_credential_issued_at?: string | null
          onboarding_inbox_connected_at?: string | null
          onboarding_provider?: string | null
          onboarding_stage?: string
          onboarding_started_at?: string | null
          onboarding_technical_activated_at?: string | null
          onboarding_value_activated_at?: string | null
          owner_id: string
          plan?: string
          slug: string
          stripe_customer_id?: string | null
          updated_at?: string
        }
        Update: {
          acquisition_landing?: string | null
          acquisition_landing_path?: string | null
          acquisition_locale?: string | null
          acquisition_referrer?: string | null
          acquisition_source?: string | null
          acquisition_utm_campaign?: string | null
          acquisition_utm_medium?: string | null
          acquisition_utm_source?: string | null
          analytics_first_credential_created_at?: string | null
          analytics_first_credential_method?: string | null
          analytics_first_inbox_connected_at?: string | null
          analytics_first_inbox_provider?: string | null
          analytics_first_tool_client?: string | null
          analytics_first_tool_name?: string | null
          analytics_first_tool_path?: string | null
          analytics_first_tool_provider?: string | null
          analytics_first_tool_reported_at?: string | null
          analytics_first_tool_used_at?: string | null
          card_diagnostics?: boolean
          created_at?: string
          deleted_at?: string | null
          display_name?: string
          draft_editor_enabled?: boolean
          draft_editor_hidden?: boolean
          free_action_cap_exempt?: boolean
          grandfathered?: boolean
          id?: string
          onboarding_client?: string | null
          onboarding_client_selected_at?: string | null
          onboarding_connection_verified_at?: string | null
          onboarding_credential_issued_at?: string | null
          onboarding_inbox_connected_at?: string | null
          onboarding_provider?: string | null
          onboarding_stage?: string
          onboarding_started_at?: string | null
          onboarding_technical_activated_at?: string | null
          onboarding_value_activated_at?: string | null
          owner_id?: string
          plan?: string
          slug?: string
          stripe_customer_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspaces_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      billing_funnel_by_workspace: {
        Row: {
          abandoned_checkout: boolean | null
          checkouts_completed: number | null
          checkouts_failed: number | null
          checkouts_started: number | null
          first_checkout_at: string | null
          first_paywall_at: string | null
          first_pricing_view_at: string | null
          first_upgrade_at: string | null
          paid_at: string | null
          paywall_hits: number | null
          plan: string | null
          plan_changes_unfinished: number | null
          plan_downgrades: number | null
          plan_upgrades: number | null
          pricing_views: number | null
          workspace_id: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      accept_workspace_invite: {
        Args: { p_token_hash: string }
        Returns: {
          role: string
          workspace_id: string
          workspace_slug: string
        }[]
      }
      claim_billing_emails: {
        Args: { p_limit?: number }
        Returns: {
          attempts: number
          cancel_reason: string | null
          cancelled_at: string | null
          category: string | null
          claimed_at: string | null
          created_at: string
          id: number
          last_error: string | null
          payload: Json
          period_start: string | null
          recipient: string
          resend_id: string | null
          scope_key: string
          send_after: string
          sent_at: string | null
          stripe_customer_id: string | null
          template: string
          updated_at: string
          user_id: string | null
          workspace_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "billing_email_sends"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      create_workspace: {
        Args: { p_name: string }
        Returns: {
          display_name: string
          id: string
          plan: string
          slug: string
        }[]
      }
      dispatch_billing_lifecycle: {
        Args: { p_mode?: string }
        Returns: undefined
      }
      dispatch_scheduled_sends: { Args: never; Returns: undefined }
      dispatch_triage_rules: { Args: never; Returns: undefined }
      effective_workspace_plan: {
        Args: { p_workspace_id: string }
        Returns: {
          comped_scale: boolean
          plan: string
          unlimited_inboxes: boolean
        }[]
      }
      emit_system_event: {
        Args: { p_event_type: string; p_payload: Json }
        Returns: undefined
      }
      ensure_activity_log_partitions: {
        Args: { months_ahead?: number }
        Returns: undefined
      }
      experiment_assign: {
        Args: { p_key: string; p_subject_id: string; p_variant_id: string }
        Returns: string
      }
      experiment_has_variant: {
        Args: { p_variant_id: string; p_variants: Json }
        Returns: boolean
      }
      experiment_link_subject: {
        Args: {
          p_subject_id: string
          p_user_id: string
          p_workspace_id: string
        }
        Returns: undefined
      }
      experiment_stats: {
        Args: { p_key: string }
        Returns: {
          assigned: number
          converted: number
          retained: number
          retention_eligible: number
          signed_up: number
          variant_id: string
        }[]
      }
      experiment_variants_valid: {
        Args: { p_variants: Json }
        Returns: boolean
      }
      expire_workspace_invites: { Args: never; Returns: undefined }
      finalize_action_usage_reservation: {
        Args: { p_reservation_id: string; p_succeeded: boolean }
        Returns: boolean
      }
      get_current_user_sessions: {
        Args: never
        Returns: {
          created_at: string
          id: string
          ip: string
          not_after: string
          refreshed_at: string
          updated_at: string
          user_agent: string
        }[]
      }
      get_workspace_acquisition_summary: {
        Args: { p_dimension?: string; p_min_bucket?: number; p_since?: string }
        Returns: {
          bucket: string
          workspace_count: number
        }[]
      }
      get_workspace_members: {
        Args: { p_workspace_id: string }
        Returns: {
          avatar_url: string
          display_name: string
          email: string
          joined_at: string
          role: string
          user_id: string
        }[]
      }
      gmail_oauth_cap_summary: {
        Args: never
        Returns: {
          active: number
          distinct_ever: number
          first_grant_at: string
          google_reported_at: string
          google_reported_users: number
          grants_last_30d: number
          grants_last_60d: number
          live: number
        }[]
      }
      gmail_oauth_grant_series: {
        Args: never
        Returns: {
          cumulative_grants: number
          month: string
          new_grants: number
        }[]
      }
      growth_acquisition_channels: {
        Args: { p_days?: number }
        Returns: {
          activated: number
          paying: number
          returned: number
          signups: number
          source: string
        }[]
      }
      growth_activation_funnel: {
        Args: { p_days: number }
        Returns: {
          stage: string
          stage_index: number
          workspaces: number
        }[]
      }
      growth_active_workspaces: {
        Args: { p_days: number }
        Returns: {
          active_days: number
          calls: number
          client: string
          created_at: string
          errors: number
          inboxes: number
          is_comped: boolean
          last_active_at: string
          owner_email: string
          plan: string
          providers: string
          sessions: number
          successes: number
          value_activated_at: string
          workspace_id: string
          workspace_name: string
        }[]
      }
      growth_client_mix: {
        Args: never
        Returns: {
          client: string
          workspaces: number
        }[]
      }
      growth_cohort_retention: {
        Args: { p_weeks: number }
        Returns: {
          cohort_size: number
          cohort_week: string
          retained: number
          week_index: number
        }[]
      }
      growth_daily_metrics: {
        Args: { p_days: number }
        Returns: {
          active_28d: number
          active_7d: number
          calls: number
          day: string
          errors: number
          new_workspaces: number
          rate_limited: number
          successes: number
          technical_activations: number
          value_activations: number
        }[]
      }
      growth_engagement_bands: {
        Args: { p_days: number }
        Returns: {
          band: string
          metric: string
          workspaces: number
        }[]
      }
      growth_error_breakdown: {
        Args: { p_days: number }
        Returns: {
          calls: number
          error_code: string
          failures: number
          tool_name: string
        }[]
      }
      growth_inbox_distribution: {
        Args: never
        Returns: {
          band: string
          band_index: number
          capped: number
          exempt: number
          paid: number
        }[]
      }
      growth_inbox_label: {
        Args: { p_provider: string; p_service: string }
        Returns: string
      }
      growth_is_internal_email:
        | { Args: { p_email: string }; Returns: boolean }
        | {
            Args: {
              p_email: string
              p_internal_domains: string[]
              p_internal_emails: string[]
            }
            Returns: boolean
          }
      growth_lifecycle_counts: {
        Args: never
        Returns: {
          active_28d: number
          active_7d: number
          at_risk: number
          one_and_done: number
          value_activated: number
        }[]
      }
      growth_oauth_abandonment: {
        Args: never
        Returns: {
          abandoned: number
          connected: number
          provider: string
        }[]
      }
      growth_people_counts: {
        Args: {
          p_days?: number
          p_internal_domains?: string[]
          p_internal_emails?: string[]
        }
        Returns: {
          activated_users: number
          active_users: number
          active_users_7d: number
          internal_users: number
          new_users: number
          prev_active_users: number
          prev_new_users: number
          total_users: number
          total_users_prior: number
        }[]
      }
      growth_provider_funnel: {
        Args: { p_days: number }
        Returns: {
          attempts: number
          failures: number
          provider: string
          successes: number
          top_error: string
          workspaces_attempted: number
          workspaces_connected: number
        }[]
      }
      growth_provider_mix: {
        Args: never
        Returns: {
          inboxes: number
          provider: string
        }[]
      }
      growth_public_tool_name: {
        Args: { p_tool_name: string }
        Returns: string
      }
      growth_retention_curve: {
        Args: {
          p_internal_domains?: string[]
          p_internal_emails?: string[]
          p_weeks: number
        }
        Returns: {
          eligible: number
          retained: number
          week_index: number
        }[]
      }
      growth_revenue_counts: {
        Args: { p_internal_domains?: string[]; p_internal_emails?: string[] }
        Returns: {
          comped_owners: number
          comped_workspaces: number
          free_workspaces: number
          internal_paying_workspaces: number
          internal_workspaces: number
          paying_owners: number
          paying_personal: number
          paying_scale: number
          paying_solo: number
          paying_workspaces: number
        }[]
      }
      growth_upgrade_pressure: {
        Args: { p_free_inbox_cap?: number }
        Returns: {
          at_ceiling: number
          at_ceiling_activated: number
          capped_activated: number
          capped_workspaces: number
          comped_workspaces: number
          grandfathered_over_free: number
          grandfathered_workspaces: number
          paid_workspaces: number
        }[]
      }
      growth_usage_cap_overview: {
        Args: {
          p_internal_domains?: string[]
          p_internal_emails?: string[]
          p_window_days?: number
        }
        Returns: {
          capped: number
          capped_eligible: number
          capped_retained: number
          email_100_queued: number
          email_100_sent: number
          email_80_queued: number
          email_80_sent: number
          email_pause_queued: number
          email_pause_sent: number
          exempt_early: number
          exempt_support: number
          funnel_capped: number
          funnel_checkout_completed: number
          funnel_checkout_started: number
          funnel_pricing_viewed: number
          half: number
          in_grace: number
          metered: number
          pauses_window: number
          refusals_window: number
          refused_workspaces_window: number
          rules_paused_now: number
          uncapped_eligible: number
          uncapped_retained: number
          under_half: number
          warn: number
          workspaces_paused_now: number
        }[]
      }
      growth_usage_cap_states: {
        Args: { p_internal_domains?: string[]; p_internal_emails?: string[] }
        Returns: {
          cap: number
          created_at: string
          grace_ends_at: string
          owner_email: string
          owner_id: string
          period_end: string
          period_start: string
          plan: string
          remaining: number
          state: string
          used: number
          workspace_id: string
          workspace_name: string
        }[]
      }
      growth_usage_cap_workspaces: {
        Args: { p_internal_domains?: string[]; p_internal_emails?: string[] }
        Returns: {
          cap: number
          created_at: string
          emails_queued: string
          emails_sent: string
          last_action_at: string
          owner_domain: string
          owner_email: string
          owner_id: string
          paused_rules: number
          period_end: string
          period_start: string
          refusals: number
          remaining: number
          state: string
          used: number
          workspace_id: string
          workspace_name: string
        }[]
      }
      growth_usage_volume: {
        Args: { p_days?: number; p_meter_version?: number }
        Returns: {
          billable_actions: number
          billable_workspaces: number
          cap_hit_workspaces: number
          cap_rejections: number
          total_workspaces: number
        }[]
      }
      growth_user_activity: {
        Args: { p_days: number; p_user_id: string }
        Returns: {
          calls: number
          day: string
          failures: number
          successes: number
        }[]
      }
      growth_user_directory: {
        Args: { p_days: number; p_limit: number; p_user_id: string }
        Returns: {
          acquisition_landing_path: string
          acquisition_locale: string
          acquisition_referrer: string
          acquisition_source: string
          acquisition_utm_campaign: string
          acquisition_utm_medium: string
          acquisition_utm_source: string
          active_days: number
          api_keys: number
          avatar_url: string
          billing_plan: string
          calls: number
          current_period_end: string
          display_name: string
          email: string
          first_credential_created_at: string
          first_credential_method: string
          first_inbox_connected_at: string
          first_inbox_provider: string
          first_tool_client: string
          first_tool_name: string
          first_tool_used_at: string
          grandfathered: boolean
          inboxes: number
          inboxes_broken: number
          is_comped: boolean
          is_internal: boolean
          key_last_used_at: string
          last_active_at: string
          memberships: number
          onboarding_client: string
          onboarding_stage: string
          paywall_hits: number
          plan: string
          primary_workspace_id: string
          primary_workspace_name: string
          primary_workspace_slug: string
          providers: string
          signed_up_at: string
          stripe_customer_id: string
          subscription_status: string
          successes: number
          total_rows: number
          unlimited_inboxes: boolean
          unsubscribed_at: string
          unsubscribed_categories: string[]
          user_id: string
          value_activated_at: string
          workspaces: number
        }[]
      }
      growth_user_errors: {
        Args: { p_days: number; p_user_id: string }
        Returns: {
          calls: number
          error_code: string
          last_at: string
          tool_name: string
        }[]
      }
      growth_user_inboxes: {
        Args: { p_days: number; p_user_id: string }
        Returns: {
          calls: number
          created_at: string
          deleted_at: string
          display_name: string
          email_address: string
          inbox_id: string
          last_error: string
          last_sync_at: string
          last_used_at: string
          provider: string
          send_approval_required: boolean
          signature_enabled: boolean
          status: string
          successes: number
          workspace_id: string
          workspace_name: string
        }[]
      }
      growth_user_signup_days: {
        Args: {
          p_days?: number
          p_internal_domains?: string[]
          p_internal_emails?: string[]
        }
        Returns: {
          activated_users: number
          cumulative_users: number
          day: string
          new_users: number
        }[]
      }
      growth_user_timeline: {
        Args: { p_limit: number; p_user_id: string }
        Returns: {
          detail: string
          kind: string
          occurred_at: string
          title: string
          tone: string
        }[]
      }
      growth_user_tools: {
        Args: { p_days: number; p_user_id: string }
        Returns: {
          calls: number
          failures: number
          last_used_at: string
          median_ms: number
          successes: number
          tool_name: string
        }[]
      }
      growth_user_workspaces: {
        Args: { p_days: number; p_user_id: string }
        Returns: {
          acquisition_landing_path: string
          acquisition_referrer: string
          acquisition_source: string
          acquisition_utm_campaign: string
          acquisition_utm_medium: string
          acquisition_utm_source: string
          api_keys: number
          calls: number
          created_at: string
          credential_created_at: string
          deleted_at: string
          first_tool_used_at: string
          grandfathered: boolean
          inbox_connected_at: string
          inboxes: number
          last_active_at: string
          members: number
          name: string
          onboarding_stage: string
          plan: string
          role: string
          slug: string
          successes: number
          value_activated_at: string
          workspace_id: string
        }[]
      }
      growth_utilization_bands: {
        Args: { p_caps: Json; p_meter_version?: number }
        Returns: {
          band: string
          workspaces: number
        }[]
      }
      internal_account_domains: { Args: never; Returns: string[] }
      internal_account_emails: { Args: never; Returns: string[] }
      invoke_outlook_token_refresh: { Args: never; Returns: undefined }
      invoke_synthetic_monitor: {
        Args: { controlled_failure?: boolean; mode: string }
        Returns: undefined
      }
      mark_synthetic_monitor_incident_alerted: {
        Args: { p_incident_id: string }
        Returns: undefined
      }
      mark_synthetic_monitor_recovery_alerted: {
        Args: { p_incident_id: string }
        Returns: undefined
      }
      my_workspace_ids: { Args: never; Returns: string[] }
      rate_limit_check: {
        Args: { p_key: string; p_max_count: number; p_window_ms: number }
        Returns: boolean
      }
      record_synthetic_monitor_failure: {
        Args: {
          p_failed_step: string
          p_failure_class: string
          p_fingerprint: string
          p_run_id: string
        }
        Returns: {
          fingerprint: string
          id: string
          should_alert: boolean
        }[]
      }
      record_usage_limit_event: {
        Args: {
          p_cap: number
          p_meter_version: number
          p_period_start: string
          p_plan: string
          p_used_actions: number
          p_workspace_id: string
        }
        Returns: boolean
      }
      reserve_action_usage: {
        Args: {
          p_cap: number
          p_meter_version: number
          p_period_end: string
          p_period_start: string
          p_tool_name: string
          p_workspace_id: string
        }
        Returns: {
          allowed: boolean
          reservation_id: string
          used_actions: number
        }[]
      }
      resolve_synthetic_monitor_incidents: {
        Args: { p_run_id: string }
        Returns: {
          fingerprint: string
          id: string
          should_recover: boolean
        }[]
      }
      revoke_dormant_oauth_grants: {
        Args: { p_dry_run?: boolean; p_idle_days?: number }
        Returns: {
          access_tokens_revoked: number
          grants_selected: number
          refresh_tokens_revoked: number
        }[]
      }
      revoke_user_session: {
        Args: { p_session_id: string }
        Returns: {
          revoked_session_id: string
        }[]
      }
      signup_scoreboard: {
        Args: never
        Returns: {
          internal_excluded: number
          last_24h: number
          last_7d: number
          total: number
        }[]
      }
      workspace_action_allowance: {
        Args: { p_workspace_id: string }
        Returns: {
          cap: number
          exempt: boolean
          exempt_reason: string
          grace_ends_at: string
          in_grace: boolean
          owner_id: string
          period_end: string
          period_start: string
          plan: string
          remaining: number
          used: number
        }[]
      }
      workspace_inbox_activity: {
        Args: { p_days?: number; p_workspace_id: string }
        Returns: {
          calls: number
          inbox_id: string
          last_success_at: string
        }[]
      }
      workspace_usage_summary: {
        Args: {
          p_days?: number
          p_meter_version?: number
          p_period_end: string
          p_period_start: string
          p_workspace_id: string
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
