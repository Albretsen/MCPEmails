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
      activation_marker_corrections_20261026: {
        Row: {
          corrected_at: string
          new_first_tool_used_at: string | null
          old_first_tool_client: string | null
          old_first_tool_name: string | null
          old_first_tool_path: string | null
          old_first_tool_provider: string | null
          old_first_tool_used_at: string | null
          old_onboarding_stage: string | null
          old_technical_activated_at: string | null
          workspace_id: string
        }
        Insert: {
          corrected_at?: string
          new_first_tool_used_at?: string | null
          old_first_tool_client?: string | null
          old_first_tool_name?: string | null
          old_first_tool_path?: string | null
          old_first_tool_provider?: string | null
          old_first_tool_used_at?: string | null
          old_onboarding_stage?: string | null
          old_technical_activated_at?: string | null
          workspace_id: string
        }
        Update: {
          corrected_at?: string
          new_first_tool_used_at?: string | null
          old_first_tool_client?: string | null
          old_first_tool_name?: string | null
          old_first_tool_path?: string | null
          old_first_tool_provider?: string | null
          old_first_tool_used_at?: string | null
          old_onboarding_stage?: string | null
          old_technical_activated_at?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "activation_marker_corrections_20261026_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "activation_marker_corrections_20261026_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
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
          card_listed: boolean | null
          created_at: string
          created_by: string | null
          deleted_at: string | null
          expires_at: string | null
          id: string
          inbox_ids: string[] | null
          key_hash: string
          key_prefix: string
          kind: string | null
          last_used_at: string | null
          name: string
          scopes: string[]
          updated_at: string
          workspace_id: string
        }
        Insert: {
          card_build_notified?: string | null
          card_listed?: boolean | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          expires_at?: string | null
          id?: string
          inbox_ids?: string[] | null
          key_hash: string
          key_prefix: string
          kind?: string | null
          last_used_at?: string | null
          name: string
          scopes?: string[]
          updated_at?: string
          workspace_id: string
        }
        Update: {
          card_build_notified?: string | null
          card_listed?: boolean | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          expires_at?: string | null
          id?: string
          inbox_ids?: string[] | null
          key_hash?: string
          key_prefix?: string
          kind?: string | null
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
      assistant_usage: {
        Row: {
          cost_micro_usd: number
          created_at: string
          id: string
          input_tokens: number
          model: string
          occurred_at: string
          output_tokens: number
          user_id: string | null
          workspace_id: string
        }
        Insert: {
          cost_micro_usd?: number
          created_at?: string
          id?: string
          input_tokens?: number
          model: string
          occurred_at?: string
          output_tokens?: number
          user_id?: string | null
          workspace_id: string
        }
        Update: {
          cost_micro_usd?: number
          created_at?: string
          id?: string
          input_tokens?: number
          model?: string
          occurred_at?: string
          output_tokens?: number
          user_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "assistant_usage_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assistant_usage_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "assistant_usage_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      assistant_usage_reservations: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          user_id: string | null
          workspace_id: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          id?: string
          user_id?: string | null
          workspace_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          user_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "assistant_usage_reservations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assistant_usage_reservations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "assistant_usage_reservations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      auth_hook_switches: {
        Row: {
          enabled: boolean
          name: string
          updated_at: string
        }
        Insert: {
          enabled?: boolean
          name: string
          updated_at?: string
        }
        Update: {
          enabled?: boolean
          name?: string
          updated_at?: string
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
          recovered_by: string | null
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
          recovered_by?: string | null
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
          recovered_by?: string | null
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
      business_founder_places: {
        Row: {
          created_at: string
          interval: string
          owner_id: string
          stripe_subscription_id: string
        }
        Insert: {
          created_at?: string
          interval: string
          owner_id: string
          stripe_subscription_id: string
        }
        Update: {
          created_at?: string
          interval?: string
          owner_id?: string
          stripe_subscription_id?: string
        }
        Relationships: []
      }
      cancellation_feedback: {
        Row: {
          created_at: string
          detail: string | null
          id: string
          period_end: string | null
          reason: string
          source: string
          stripe_customer_id: string | null
          subscription_id: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          detail?: string | null
          id?: string
          period_end?: string | null
          reason: string
          source: string
          stripe_customer_id?: string | null
          subscription_id: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          detail?: string | null
          id?: string
          period_end?: string | null
          reason?: string
          source?: string
          stripe_customer_id?: string | null
          subscription_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cancellation_feedback_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      checkout_cancel_feedback: {
        Row: {
          created_at: string
          detail: string | null
          id: string
          reason: string
          target: string | null
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          detail?: string | null
          id?: string
          reason: string
          target?: string | null
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          detail?: string | null
          id?: string
          reason?: string
          target?: string | null
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "checkout_cancel_feedback_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "checkout_cancel_feedback_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "checkout_cancel_feedback_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      checkout_links: {
        Row: {
          billing_interval: string
          blocked_tool: string | null
          client_label: string
          completed_at: string | null
          created_at: string
          expires_at: string
          first_opened_at: string | null
          id: string
          open_count: number
          owner_user_id: string
          plan_id: string
          stripe_session_expires_at: string | null
          stripe_session_id: string | null
          token_hash: string
          variant: string
          workspace_id: string
        }
        Insert: {
          billing_interval?: string
          blocked_tool?: string | null
          client_label?: string
          completed_at?: string | null
          created_at?: string
          expires_at: string
          first_opened_at?: string | null
          id: string
          open_count?: number
          owner_user_id: string
          plan_id?: string
          stripe_session_expires_at?: string | null
          stripe_session_id?: string | null
          token_hash: string
          variant?: string
          workspace_id: string
        }
        Update: {
          billing_interval?: string
          blocked_tool?: string | null
          client_label?: string
          completed_at?: string | null
          created_at?: string
          expires_at?: string
          first_opened_at?: string | null
          id?: string
          open_count?: number
          owner_user_id?: string
          plan_id?: string
          stripe_session_expires_at?: string | null
          stripe_session_id?: string | null
          token_hash?: string
          variant?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "checkout_links_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "checkout_links_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      deleted_account_tally: {
        Row: {
          deleted_at: string
          ever_paid: boolean
          id: number
          plan_at_deletion: string | null
          purged_at: string
          signed_up_at: string
          was_internal: boolean
        }
        Insert: {
          deleted_at: string
          ever_paid: boolean
          id?: never
          plan_at_deletion?: string | null
          purged_at?: string
          signed_up_at: string
          was_internal: boolean
        }
        Update: {
          deleted_at?: string
          ever_paid?: boolean
          id?: never
          plan_at_deletion?: string | null
          purged_at?: string
          signed_up_at?: string
          was_internal?: boolean
        }
        Relationships: []
      }
      draft_card_activity: {
        Row: {
          action: string
          api_key_id: string
          bcc_count: number | null
          cc_count: number | null
          created_at: string
          draft_id: string
          fields: string[]
          id: string
          inbox_id: string
          line_id: string | null
          occurred_at: string
          reported_at: string | null
          revision: number | null
          to_count: number | null
          workspace_id: string
        }
        Insert: {
          action: string
          api_key_id: string
          bcc_count?: number | null
          cc_count?: number | null
          created_at?: string
          draft_id: string
          fields?: string[]
          id?: string
          inbox_id: string
          line_id?: string | null
          occurred_at: string
          reported_at?: string | null
          revision?: number | null
          to_count?: number | null
          workspace_id: string
        }
        Update: {
          action?: string
          api_key_id?: string
          bcc_count?: number | null
          cc_count?: number | null
          created_at?: string
          draft_id?: string
          fields?: string[]
          id?: string
          inbox_id?: string
          line_id?: string | null
          occurred_at?: string
          reported_at?: string | null
          revision?: number | null
          to_count?: number | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "draft_card_activity_api_key_id_fkey"
            columns: ["api_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "draft_card_activity_inbox_id_fkey"
            columns: ["inbox_id"]
            isOneToOne: false
            referencedRelation: "inboxes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "draft_card_activity_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "draft_card_activity_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      draft_events: {
        Row: {
          api_key_id: string | null
          card_offered: boolean | null
          event: string
          id: string
          inbox_id: string | null
          line_id: string | null
          occurred_at: string
          source: string
          via_card: boolean
          workspace_id: string
        }
        Insert: {
          api_key_id?: string | null
          card_offered?: boolean | null
          event: string
          id?: string
          inbox_id?: string | null
          line_id?: string | null
          occurred_at?: string
          source?: string
          via_card?: boolean
          workspace_id: string
        }
        Update: {
          api_key_id?: string | null
          card_offered?: boolean | null
          event?: string
          id?: string
          inbox_id?: string | null
          line_id?: string | null
          occurred_at?: string
          source?: string
          via_card?: boolean
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "draft_events_api_key_id_fkey"
            columns: ["api_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "draft_events_inbox_id_fkey"
            columns: ["inbox_id"]
            isOneToOne: false
            referencedRelation: "inboxes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "draft_events_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "draft_events_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      draft_lineage: {
        Row: {
          closed_at: string | null
          closed_reason: string | null
          created_at: string
          draft_id: string
          id: string
          inbox_id: string
          line_id: string
          revision: number
          workspace_id: string
          written_at: string
          written_by: string
        }
        Insert: {
          closed_at?: string | null
          closed_reason?: string | null
          created_at?: string
          draft_id: string
          id?: string
          inbox_id: string
          line_id: string
          revision: number
          workspace_id: string
          written_at?: string
          written_by: string
        }
        Update: {
          closed_at?: string | null
          closed_reason?: string | null
          created_at?: string
          draft_id?: string
          id?: string
          inbox_id?: string
          line_id?: string
          revision?: number
          workspace_id?: string
          written_at?: string
          written_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "draft_lineage_inbox_id_fkey"
            columns: ["inbox_id"]
            isOneToOne: false
            referencedRelation: "inboxes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "draft_lineage_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "draft_lineage_workspace_id_fkey"
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
      first30_dry_run_log: {
        Row: {
          decision: string
          detail: Json | null
          error: string | null
          first_paid_at: string | null
          id: number
          owner_internal: boolean | null
          reason: string | null
          recipient_matches_owner: boolean | null
          run_at: string
          run_id: string
          subscription_active: boolean | null
          template: string | null
          workspace_id: string | null
        }
        Insert: {
          decision: string
          detail?: Json | null
          error?: string | null
          first_paid_at?: string | null
          id?: never
          owner_internal?: boolean | null
          reason?: string | null
          recipient_matches_owner?: boolean | null
          run_at?: string
          run_id: string
          subscription_active?: boolean | null
          template?: string | null
          workspace_id?: string | null
        }
        Update: {
          decision?: string
          detail?: Json | null
          error?: string | null
          first_paid_at?: string | null
          id?: never
          owner_internal?: boolean | null
          reason?: string | null
          recipient_matches_owner?: boolean | null
          run_at?: string
          run_id?: string
          subscription_active?: boolean | null
          template?: string | null
          workspace_id?: string | null
        }
        Relationships: []
      }
      growth_activity_daily: {
        Row: {
          calls: number
          day: string
          errors: number
          first_success_at: string | null
          first_success_starts: boolean | null
          last_call_at: string
          last_success_at: string | null
          last_value_success_at: string | null
          rate_limited: number
          session_starts: number
          successes: number
          value_successes: number
          workspace_id: string
        }
        Insert: {
          calls: number
          day: string
          errors: number
          first_success_at?: string | null
          first_success_starts?: boolean | null
          last_call_at: string
          last_success_at?: string | null
          last_value_success_at?: string | null
          rate_limited: number
          session_starts: number
          successes: number
          value_successes: number
          workspace_id: string
        }
        Update: {
          calls?: number
          day?: string
          errors?: number
          first_success_at?: string | null
          first_success_starts?: boolean | null
          last_call_at?: string
          last_success_at?: string | null
          last_value_success_at?: string | null
          rate_limited?: number
          session_starts?: number
          successes?: number
          value_successes?: number
          workspace_id?: string
        }
        Relationships: []
      }
      growth_milestone_unlocks: {
        Row: {
          day: string
          id: string
          note: string
          recorded_at: string
        }
        Insert: {
          day: string
          id: string
          note: string
          recorded_at?: string
        }
        Update: {
          day?: string
          id?: string
          note?: string
          recorded_at?: string
        }
        Relationships: []
      }
      growth_tool_daily: {
        Row: {
          calls: number
          day: string
          error_code: string | null
          status: string
          tool_name: string
        }
        Insert: {
          calls: number
          day: string
          error_code?: string | null
          status: string
          tool_name: string
        }
        Update: {
          calls?: number
          day?: string
          error_code?: string | null
          status?: string
          tool_name?: string
        }
        Relationships: []
      }
      inbox_autofill_lookups: {
        Row: {
          created_at: string
          domain: string
          id: number
          imap_host: string | null
          kind: string | null
          smtp_host: string | null
          source: string
          surface: string
          user_id: string
        }
        Insert: {
          created_at?: string
          domain: string
          id?: never
          imap_host?: string | null
          kind?: string | null
          smtp_host?: string | null
          source: string
          surface: string
          user_id: string
        }
        Update: {
          created_at?: string
          domain?: string
          id?: never
          imap_host?: string | null
          kind?: string | null
          smtp_host?: string | null
          source?: string
          surface?: string
          user_id?: string
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
      inbox_send_brakes: {
        Row: {
          fanout_hold_until: string | null
          inbox_id: string
          refusal_pause_until: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          fanout_hold_until?: string | null
          inbox_id: string
          refusal_pause_until?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          fanout_hold_until?: string | null
          inbox_id?: string
          refusal_pause_until?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "inbox_send_brakes_inbox_id_fkey"
            columns: ["inbox_id"]
            isOneToOne: true
            referencedRelation: "inboxes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inbox_send_brakes_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "inbox_send_brakes_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      inbox_sender_aliases: {
        Row: {
          code_attempts: number
          code_expires_at: string | null
          code_hash: string | null
          code_sent_at: string | null
          created_at: string
          created_by: string | null
          display_name: string | null
          email_address: string
          id: string
          inbox_id: string
          updated_at: string
          verified_at: string | null
          workspace_id: string
        }
        Insert: {
          code_attempts?: number
          code_expires_at?: string | null
          code_hash?: string | null
          code_sent_at?: string | null
          created_at?: string
          created_by?: string | null
          display_name?: string | null
          email_address: string
          id?: string
          inbox_id: string
          updated_at?: string
          verified_at?: string | null
          workspace_id: string
        }
        Update: {
          code_attempts?: number
          code_expires_at?: string | null
          code_hash?: string | null
          code_sent_at?: string | null
          created_at?: string
          created_by?: string | null
          display_name?: string | null
          email_address?: string
          id?: string
          inbox_id?: string
          updated_at?: string
          verified_at?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "inbox_sender_aliases_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inbox_sender_aliases_inbox_id_fkey"
            columns: ["inbox_id"]
            isOneToOne: false
            referencedRelation: "inboxes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inbox_sender_aliases_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "inbox_sender_aliases_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      inbox_watch_state: {
        Row: {
          backoff_until: string | null
          created_at: string
          failure_count: number
          folders: Json
          inbox_id: string
          last_changed_at: string | null
          last_checked_at: string | null
          last_error_code: string | null
          last_notified_at: string | null
          lease_id: string | null
          leased_until: string | null
          next_check_at: string
        }
        Insert: {
          backoff_until?: string | null
          created_at?: string
          failure_count?: number
          folders?: Json
          inbox_id: string
          last_changed_at?: string | null
          last_checked_at?: string | null
          last_error_code?: string | null
          last_notified_at?: string | null
          lease_id?: string | null
          leased_until?: string | null
          next_check_at?: string
        }
        Update: {
          backoff_until?: string | null
          created_at?: string
          failure_count?: number
          folders?: Json
          inbox_id?: string
          last_changed_at?: string | null
          last_checked_at?: string | null
          last_error_code?: string | null
          last_notified_at?: string | null
          lease_id?: string | null
          leased_until?: string | null
          next_check_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inbox_watch_state_inbox_id_fkey"
            columns: ["inbox_id"]
            isOneToOne: true
            referencedRelation: "inboxes"
            referencedColumns: ["id"]
          },
        ]
      }
      inboxes: {
        Row: {
          ai_instructions: string | null
          ai_instructions_updated_at: string | null
          bulk_review_mode: string
          created_at: string
          deleted_at: string | null
          display_name: string | null
          draft_editor_hidden: boolean
          email_address: string
          folder_overrides: Json | null
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
          parked_at: string | null
          parked_reason: string | null
          provider: string
          send_approval_required: boolean
          send_review_mode: string
          service: string | null
          signature_embed_images: boolean
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
          ai_instructions?: string | null
          ai_instructions_updated_at?: string | null
          bulk_review_mode?: string
          created_at?: string
          deleted_at?: string | null
          display_name?: string | null
          draft_editor_hidden?: boolean
          email_address: string
          folder_overrides?: Json | null
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
          parked_at?: string | null
          parked_reason?: string | null
          provider: string
          send_approval_required?: boolean
          send_review_mode?: string
          service?: string | null
          signature_embed_images?: boolean
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
          ai_instructions?: string | null
          ai_instructions_updated_at?: string | null
          bulk_review_mode?: string
          created_at?: string
          deleted_at?: string | null
          display_name?: string | null
          draft_editor_hidden?: boolean
          email_address?: string
          folder_overrides?: Json | null
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
          parked_at?: string | null
          parked_reason?: string | null
          provider?: string
          send_approval_required?: boolean
          send_review_mode?: string
          service?: string | null
          signature_embed_images?: boolean
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
          finished_at: string | null
          provider_message_id: string | null
          recovered_at: string | null
          recovered_session_id: string | null
          recovered_via_link: boolean | null
          sent_at: string
          status: string
          template: string
          trigger_key: string
          user_id: string
        }
        Insert: {
          detail?: string | null
          email: string
          finished_at?: string | null
          provider_message_id?: string | null
          recovered_at?: string | null
          recovered_session_id?: string | null
          recovered_via_link?: boolean | null
          sent_at?: string
          status?: string
          template: string
          trigger_key: string
          user_id: string
        }
        Update: {
          detail?: string | null
          email?: string
          finished_at?: string | null
          provider_message_id?: string | null
          recovered_at?: string | null
          recovered_session_id?: string | null
          recovered_via_link?: boolean | null
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
      mail_relay_candidates: {
        Row: {
          direct_successes: number
          first_rescue_at: string
          host: string
          last_reason: string | null
          last_rescue_at: string
          last_runtime: string | null
          protocol: string
          refused: boolean
          rescues: number
        }
        Insert: {
          direct_successes?: number
          first_rescue_at?: string
          host: string
          last_reason?: string | null
          last_rescue_at?: string
          last_runtime?: string | null
          protocol: string
          refused?: boolean
          rescues?: number
        }
        Update: {
          direct_successes?: number
          first_rescue_at?: string
          host?: string
          last_reason?: string | null
          last_rescue_at?: string
          last_runtime?: string | null
          protocol?: string
          refused?: boolean
          rescues?: number
        }
        Relationships: []
      }
      mail_relay_hosts: {
        Row: {
          first_learned_at: string
          host: string
          last_learned_at: string
          learned_by: string | null
          protocol: string
          reason: string | null
          source: string
          times_learned: number
        }
        Insert: {
          first_learned_at?: string
          host: string
          last_learned_at?: string
          learned_by?: string | null
          protocol: string
          reason?: string | null
          source?: string
          times_learned?: number
        }
        Update: {
          first_learned_at?: string
          host?: string
          last_learned_at?: string
          learned_by?: string | null
          protocol?: string
          reason?: string | null
          source?: string
          times_learned?: number
        }
        Relationships: []
      }
      mail_relay_stats: {
        Row: {
          count: number
          host: string
          hour: string
          last_at: string
          last_detail: string | null
          outcome: string
          protocol: string
          route: string
          runtime: string
          total_ms: number
        }
        Insert: {
          count?: number
          host: string
          hour: string
          last_at?: string
          last_detail?: string | null
          outcome: string
          protocol: string
          route: string
          runtime: string
          total_ms?: number
        }
        Update: {
          count?: number
          host?: string
          hour?: string
          last_at?: string
          last_detail?: string | null
          outcome?: string
          protocol?: string
          route?: string
          runtime?: string
          total_ms?: number
        }
        Relationships: []
      }
      maintenance_cursors: {
        Row: {
          done_at: string | null
          job: string
          next_block: number
          relname: string
          updated_at: string
        }
        Insert: {
          done_at?: string | null
          job: string
          next_block?: number
          relname: string
          updated_at?: string
        }
        Update: {
          done_at?: string | null
          job?: string
          next_block?: number
          relname?: string
          updated_at?: string
        }
        Relationships: []
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
      morning_briefs: {
        Row: {
          claimed_at: string | null
          consecutive_failures: number
          created_at: string
          enabled: boolean
          hour: number
          inbox_id: string | null
          last_error_code: string | null
          last_local_date: string | null
          last_outcome: string | null
          last_run_at: string | null
          last_sent_at: string | null
          lease_token: string | null
          locale: string
          next_due_at: string | null
          paused_at: string | null
          timezone: string
          updated_at: string
          vip_senders: string[]
          workspace_id: string
        }
        Insert: {
          claimed_at?: string | null
          consecutive_failures?: number
          created_at?: string
          enabled?: boolean
          hour?: number
          inbox_id?: string | null
          last_error_code?: string | null
          last_local_date?: string | null
          last_outcome?: string | null
          last_run_at?: string | null
          last_sent_at?: string | null
          lease_token?: string | null
          locale?: string
          next_due_at?: string | null
          paused_at?: string | null
          timezone?: string
          updated_at?: string
          vip_senders?: string[]
          workspace_id: string
        }
        Update: {
          claimed_at?: string | null
          consecutive_failures?: number
          created_at?: string
          enabled?: boolean
          hour?: number
          inbox_id?: string | null
          last_error_code?: string | null
          last_local_date?: string | null
          last_outcome?: string | null
          last_run_at?: string | null
          last_sent_at?: string | null
          lease_token?: string | null
          locale?: string
          next_due_at?: string | null
          paused_at?: string | null
          timezone?: string
          updated_at?: string
          vip_senders?: string[]
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "morning_briefs_inbox_id_fkey"
            columns: ["inbox_id"]
            isOneToOne: false
            referencedRelation: "inboxes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "morning_briefs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "morning_briefs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
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
      onboarding_morning_brief_optins: {
        Row: {
          client: string | null
          created_at: string
          locale: string
          send_at: string
          sent_at: string | null
          status: string
          time_zone: string
          updated_at: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          client?: string | null
          created_at?: string
          locale?: string
          send_at: string
          sent_at?: string | null
          status?: string
          time_zone: string
          updated_at?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          client?: string | null
          created_at?: string
          locale?: string
          send_at?: string
          sent_at?: string | null
          status?: string
          time_zone?: string
          updated_at?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "onboarding_morning_brief_optins_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "onboarding_morning_brief_optins_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "onboarding_morning_brief_optins_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
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
      outbound_send_events: {
        Row: {
          content_hash: string | null
          created_at: string
          id: number
          inbox_id: string
          kind: string
          messages: number
          recipient_hash: string | null
          workspace_id: string
        }
        Insert: {
          content_hash?: string | null
          created_at?: string
          id?: never
          inbox_id: string
          kind: string
          messages?: number
          recipient_hash?: string | null
          workspace_id: string
        }
        Update: {
          content_hash?: string | null
          created_at?: string
          id?: never
          inbox_id?: string
          kind?: string
          messages?: number
          recipient_hash?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "outbound_send_events_inbox_id_fkey"
            columns: ["inbox_id"]
            isOneToOne: false
            referencedRelation: "inboxes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outbound_send_events_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "outbound_send_events_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      pricing_switches: {
        Row: {
          enabled: boolean
          key: string
          note: string | null
          updated_at: string
        }
        Insert: {
          enabled: boolean
          key: string
          note?: string | null
          updated_at?: string
        }
        Update: {
          enabled?: boolean
          key?: string
          note?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      product_funnel_events: {
        Row: {
          auth_reason: string | null
          category: string
          connection_type: string | null
          entry_point: string | null
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
          entry_point?: string | null
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
          entry_point?: string | null
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
      push_preferences: {
        Row: {
          created_at: string
          enabled: boolean
          inbox_id: string
          payload_mode: string
          quiet_end: number | null
          quiet_start: number | null
          quiet_timezone: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          inbox_id: string
          payload_mode?: string
          quiet_end?: number | null
          quiet_start?: number | null
          quiet_timezone?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          inbox_id?: string
          payload_mode?: string
          quiet_end?: number | null
          quiet_start?: number | null
          quiet_timezone?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_preferences_inbox_id_fkey"
            columns: ["inbox_id"]
            isOneToOne: false
            referencedRelation: "inboxes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "push_preferences_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          disabled_at: string | null
          endpoint: string
          failure_count: number
          id: string
          last_success_at: string | null
          p256dh: string
          updated_at: string
          user_agent: string | null
          user_id: string
          workspace_id: string
        }
        Insert: {
          auth: string
          created_at?: string
          disabled_at?: string | null
          endpoint: string
          failure_count?: number
          id?: string
          last_success_at?: string | null
          p256dh: string
          updated_at?: string
          user_agent?: string | null
          user_id: string
          workspace_id: string
        }
        Update: {
          auth?: string
          created_at?: string
          disabled_at?: string | null
          endpoint?: string
          failure_count?: number
          id?: string
          last_success_at?: string | null
          p256dh?: string
          updated_at?: string
          user_agent?: string | null
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_subscriptions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "push_subscriptions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "push_subscriptions_workspace_id_fkey"
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
      referral_codes: {
        Row: {
          code: string
          created_at: string
          disabled_at: string | null
          user_id: string
        }
        Insert: {
          code: string
          created_at?: string
          disabled_at?: string | null
          user_id: string
        }
        Update: {
          code?: string
          created_at?: string
          disabled_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      referral_rewards: {
        Row: {
          amount_cents: number | null
          currency: string | null
          entitlement_until: string | null
          id: string
          issued_at: string
          kind: string
          referral_id: string
          side: string
          stripe_balance_txn_id: string | null
          stripe_customer_id: string | null
        }
        Insert: {
          amount_cents?: number | null
          currency?: string | null
          entitlement_until?: string | null
          id?: string
          issued_at?: string
          kind: string
          referral_id: string
          side: string
          stripe_balance_txn_id?: string | null
          stripe_customer_id?: string | null
        }
        Update: {
          amount_cents?: number | null
          currency?: string | null
          entitlement_until?: string | null
          id?: string
          issued_at?: string
          kind?: string
          referral_id?: string
          side?: string
          stripe_balance_txn_id?: string | null
          stripe_customer_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "referral_rewards_referral_id_fkey"
            columns: ["referral_id"]
            isOneToOne: false
            referencedRelation: "referrals"
            referencedColumns: ["id"]
          },
        ]
      }
      referrals: {
        Row: {
          attached_at: string
          attached_via: string
          code: string
          first_charge_at: string | null
          first_charge_id: string | null
          first_invoice_id: string | null
          friend_user_id: string
          friend_workspace_id: string | null
          hold_reason: string | null
          id: string
          ip_hash: string | null
          qualified_at: string | null
          qualifies_at: string | null
          referrer_user_id: string
          status: string
          updated_at: string
          void_reason: string | null
        }
        Insert: {
          attached_at?: string
          attached_via: string
          code: string
          first_charge_at?: string | null
          first_charge_id?: string | null
          first_invoice_id?: string | null
          friend_user_id: string
          friend_workspace_id?: string | null
          hold_reason?: string | null
          id?: string
          ip_hash?: string | null
          qualified_at?: string | null
          qualifies_at?: string | null
          referrer_user_id: string
          status?: string
          updated_at?: string
          void_reason?: string | null
        }
        Update: {
          attached_at?: string
          attached_via?: string
          code?: string
          first_charge_at?: string | null
          first_charge_id?: string | null
          first_invoice_id?: string | null
          friend_user_id?: string
          friend_workspace_id?: string | null
          hold_reason?: string | null
          id?: string
          ip_hash?: string | null
          qualified_at?: string | null
          qualifies_at?: string | null
          referrer_user_id?: string
          status?: string
          updated_at?: string
          void_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "referrals_code_fkey"
            columns: ["code"]
            isOneToOne: false
            referencedRelation: "referral_codes"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "referrals_friend_workspace_id_fkey"
            columns: ["friend_workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "referrals_friend_workspace_id_fkey"
            columns: ["friend_workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      reminders: {
        Row: {
          api_key_id: string | null
          claimed_at: string | null
          completed_at: string | null
          condition: string
          consecutive_failures: number
          created_at: string
          due_at: string
          folder: string | null
          id: string
          inbox_id: string
          kind: string
          last_checked_at: string | null
          last_error_code: string | null
          lease_token: string | null
          message_digest: string
          message_ref: Json
          next_check_at: string | null
          replied_at: string | null
          returned_at: string | null
          status: string
          summary: Json | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          api_key_id?: string | null
          claimed_at?: string | null
          completed_at?: string | null
          condition?: string
          consecutive_failures?: number
          created_at?: string
          due_at: string
          folder?: string | null
          id?: string
          inbox_id: string
          kind: string
          last_checked_at?: string | null
          last_error_code?: string | null
          lease_token?: string | null
          message_digest: string
          message_ref: Json
          next_check_at?: string | null
          replied_at?: string | null
          returned_at?: string | null
          status?: string
          summary?: Json | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          api_key_id?: string | null
          claimed_at?: string | null
          completed_at?: string | null
          condition?: string
          consecutive_failures?: number
          created_at?: string
          due_at?: string
          folder?: string | null
          id?: string
          inbox_id?: string
          kind?: string
          last_checked_at?: string | null
          last_error_code?: string | null
          lease_token?: string | null
          message_digest?: string
          message_ref?: Json
          next_check_at?: string | null
          replied_at?: string | null
          returned_at?: string | null
          status?: string
          summary?: Json | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reminders_api_key_id_fkey"
            columns: ["api_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reminders_inbox_id_fkey"
            columns: ["inbox_id"]
            isOneToOne: false
            referencedRelation: "inboxes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reminders_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "reminders_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      retention_purge_settings: {
        Row: {
          accounts_per_run: number
          dry_run: boolean
          id: number
          inboxes_per_run: number
          updated_at: string
        }
        Insert: {
          accounts_per_run?: number
          dry_run?: boolean
          id?: number
          inboxes_per_run?: number
          updated_at?: string
        }
        Update: {
          accounts_per_run?: number
          dry_run?: boolean
          id?: number
          inboxes_per_run?: number
          updated_at?: string
        }
        Relationships: []
      }
      retention_switches: {
        Row: {
          auto_go_live_at: string | null
          decided_at: string | null
          decision: string | null
          decision_detail: Json | null
          key: string
          last_probe_at: string | null
          mode: string
          updated_at: string
        }
        Insert: {
          auto_go_live_at?: string | null
          decided_at?: string | null
          decision?: string | null
          decision_detail?: Json | null
          key: string
          last_probe_at?: string | null
          mode?: string
          updated_at?: string
        }
        Update: {
          auto_go_live_at?: string | null
          decided_at?: string | null
          decision?: string | null
          decision_detail?: Json | null
          key?: string
          last_probe_at?: string | null
          mode?: string
          updated_at?: string
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
          dispatch_scheduled_send_id: string | null
          expires_at: string | null
          id: string
          inbox_id: string
          operation: string
          payload: Json
          payload_encrypted: boolean
          revision: number
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
          dispatch_scheduled_send_id?: string | null
          expires_at?: string | null
          id?: string
          inbox_id: string
          operation: string
          payload: Json
          payload_encrypted?: boolean
          revision?: number
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
          dispatch_scheduled_send_id?: string | null
          expires_at?: string | null
          id?: string
          inbox_id?: string
          operation?: string
          payload?: Json
          payload_encrypted?: boolean
          revision?: number
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
            foreignKeyName: "send_approvals_dispatch_scheduled_send_id_fkey"
            columns: ["dispatch_scheduled_send_id"]
            isOneToOne: false
            referencedRelation: "scheduled_sends"
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
      sso_audit_events: {
        Row: {
          action: string
          actor_user_id: string | null
          connection_id: string | null
          created_at: string
          details: Json
          id: string
          ip_address: unknown
          user_agent: string | null
          workspace_id: string
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          connection_id?: string | null
          created_at?: string
          details?: Json
          id?: string
          ip_address?: unknown
          user_agent?: string | null
          workspace_id: string
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          connection_id?: string | null
          created_at?: string
          details?: Json
          id?: string
          ip_address?: unknown
          user_agent?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sso_audit_events_actor_user_id_fkey"
            columns: ["actor_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sso_audit_events_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "sso_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sso_audit_events_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "sso_audit_events_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      sso_connections: {
        Row: {
          created_at: string
          created_by: string | null
          default_role: string
          display_name: string
          enforced: boolean
          id: string
          status: string
          supabase_sso_provider_id: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          default_role?: string
          display_name: string
          enforced?: boolean
          id?: string
          status?: string
          supabase_sso_provider_id?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          default_role?: string
          display_name?: string
          enforced?: boolean
          id?: string
          status?: string
          supabase_sso_provider_id?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sso_connections_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sso_connections_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "sso_connections_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      sso_domains: {
        Row: {
          connection_id: string
          created_at: string
          domain: string
          id: string
          updated_at: string
          verification_token: string
          verified_at: string | null
          workspace_id: string
        }
        Insert: {
          connection_id: string
          created_at?: string
          domain: string
          id?: string
          updated_at?: string
          verification_token?: string
          verified_at?: string | null
          workspace_id: string
        }
        Update: {
          connection_id?: string
          created_at?: string
          domain?: string
          id?: string
          updated_at?: string
          verification_token?: string
          verified_at?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sso_domains_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "sso_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sso_domains_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "sso_domains_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      stripe_webhook_events: {
        Row: {
          cancellation_reason: string | null
          event_created: string | null
          event_id: string
          event_type: string | null
          processed_at: string
          stripe_customer_id: string | null
        }
        Insert: {
          cancellation_reason?: string | null
          event_created?: string | null
          event_id: string
          event_type?: string | null
          processed_at?: string
          stripe_customer_id?: string | null
        }
        Update: {
          cancellation_reason?: string | null
          event_created?: string | null
          event_id?: string
          event_type?: string | null
          processed_at?: string
          stripe_customer_id?: string | null
        }
        Relationships: []
      }
      subscription_plans: {
        Row: {
          api_key_id: string | null
          backlog_action: string | null
          backlog_leased_until: string | null
          backlog_moved: number
          backlog_remaining: number
          created_at: string
          expires_at: string
          id: string
          inbox_id: string
          progress: Json | null
          scanned: number
          sender_count: number
          senders: Json
          senders_encrypted: boolean
          summary: Json
          truncated: boolean
          used_at: string | null
          used_by_api_key_id: string | null
          window_days: number
          workspace_id: string
        }
        Insert: {
          api_key_id?: string | null
          backlog_action?: string | null
          backlog_leased_until?: string | null
          backlog_moved?: number
          backlog_remaining?: number
          created_at?: string
          expires_at: string
          id?: string
          inbox_id: string
          progress?: Json | null
          scanned?: number
          sender_count: number
          senders: Json
          senders_encrypted?: boolean
          summary?: Json
          truncated?: boolean
          used_at?: string | null
          used_by_api_key_id?: string | null
          window_days: number
          workspace_id: string
        }
        Update: {
          api_key_id?: string | null
          backlog_action?: string | null
          backlog_leased_until?: string | null
          backlog_moved?: number
          backlog_remaining?: number
          created_at?: string
          expires_at?: string
          id?: string
          inbox_id?: string
          progress?: Json | null
          scanned?: number
          sender_count?: number
          senders?: Json
          senders_encrypted?: boolean
          summary?: Json
          truncated?: boolean
          used_at?: string | null
          used_by_api_key_id?: string | null
          window_days?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscription_plans_api_key_id_fkey"
            columns: ["api_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscription_plans_inbox_id_fkey"
            columns: ["inbox_id"]
            isOneToOne: false
            referencedRelation: "inboxes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscription_plans_used_by_api_key_id_fkey"
            columns: ["used_by_api_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscription_plans_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "subscription_plans_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      support_tickets: {
        Row: {
          category: string
          confirmation_sent_at: string | null
          context: Json
          created_at: string
          email: string
          id: string
          ip_hash: string | null
          message: string
          notified_at: string | null
          ref: string
          source: string
          status: string
          subject: string
          user_id: string | null
          workspace_id: string | null
        }
        Insert: {
          category: string
          confirmation_sent_at?: string | null
          context?: Json
          created_at?: string
          email: string
          id?: string
          ip_hash?: string | null
          message: string
          notified_at?: string | null
          ref?: string
          source: string
          status?: string
          subject: string
          user_id?: string | null
          workspace_id?: string | null
        }
        Update: {
          category?: string
          confirmation_sent_at?: string | null
          context?: Json
          created_at?: string
          email?: string
          id?: string
          ip_hash?: string | null
          message?: string
          notified_at?: string | null
          ref?: string
          source?: string
          status?: string
          subject?: string
          user_id?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "support_tickets_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "support_tickets_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
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
      unsubscribe_requests: {
        Row: {
          api_key_id: string | null
          check_after: string | null
          check_attempts: number
          check_leased_at: string | null
          checked_at: string | null
          claimed_at: string | null
          created_at: string
          display_name: string | null
          draft_id: string | null
          error: string | null
          from_address: string | null
          http_status: number | null
          id: string
          idempotency_key: string
          inbox_id: string
          method: string
          plan_id: string | null
          requested_at: string | null
          sender_domain: string | null
          sender_key: string
          status: string
          updated_at: string
          url_host: string | null
          workspace_id: string
        }
        Insert: {
          api_key_id?: string | null
          check_after?: string | null
          check_attempts?: number
          check_leased_at?: string | null
          checked_at?: string | null
          claimed_at?: string | null
          created_at?: string
          display_name?: string | null
          draft_id?: string | null
          error?: string | null
          from_address?: string | null
          http_status?: number | null
          id?: string
          idempotency_key: string
          inbox_id: string
          method: string
          plan_id?: string | null
          requested_at?: string | null
          sender_domain?: string | null
          sender_key: string
          status: string
          updated_at?: string
          url_host?: string | null
          workspace_id: string
        }
        Update: {
          api_key_id?: string | null
          check_after?: string | null
          check_attempts?: number
          check_leased_at?: string | null
          checked_at?: string | null
          claimed_at?: string | null
          created_at?: string
          display_name?: string | null
          draft_id?: string | null
          error?: string | null
          from_address?: string | null
          http_status?: number | null
          id?: string
          idempotency_key?: string
          inbox_id?: string
          method?: string
          plan_id?: string | null
          requested_at?: string | null
          sender_domain?: string | null
          sender_key?: string
          status?: string
          updated_at?: string
          url_host?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "unsubscribe_requests_api_key_id_fkey"
            columns: ["api_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "unsubscribe_requests_inbox_id_fkey"
            columns: ["inbox_id"]
            isOneToOne: false
            referencedRelation: "inboxes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "unsubscribe_requests_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "subscription_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "unsubscribe_requests_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "unsubscribe_requests_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
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
          limit_kind: string
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
          limit_kind?: string
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
          limit_kind?: string
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
          inbox_keep_order: Json | null
          last_decline_code: string | null
          park_on_end_marked_at: string | null
          park_on_end_subscription_id: string | null
          pause_history: Json
          pause_resumes_at: string | null
          paused_from: string | null
          pending_plan: string | null
          pending_plan_effective_at: string | null
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
          inbox_keep_order?: Json | null
          last_decline_code?: string | null
          park_on_end_marked_at?: string | null
          park_on_end_subscription_id?: string | null
          pause_history?: Json
          pause_resumes_at?: string | null
          paused_from?: string | null
          pending_plan?: string | null
          pending_plan_effective_at?: string | null
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
          inbox_keep_order?: Json | null
          last_decline_code?: string | null
          park_on_end_marked_at?: string | null
          park_on_end_subscription_id?: string | null
          pause_history?: Json
          pause_resumes_at?: string | null
          paused_from?: string | null
          pending_plan?: string | null
          pending_plan_effective_at?: string | null
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
      user_passes: {
        Row: {
          amount_minor: number | null
          created_at: string
          currency: string | null
          ends_at: string
          expired_at: string | null
          id: string
          plan: string
          product: string
          refunded_at: string | null
          reminder_queued_at: string | null
          starts_at: string
          status: string
          stripe_checkout_session_id: string
          stripe_payment_intent_id: string | null
          user_id: string
        }
        Insert: {
          amount_minor?: number | null
          created_at?: string
          currency?: string | null
          ends_at: string
          expired_at?: string | null
          id?: string
          plan?: string
          product?: string
          refunded_at?: string | null
          reminder_queued_at?: string | null
          starts_at: string
          status: string
          stripe_checkout_session_id: string
          stripe_payment_intent_id?: string | null
          user_id: string
        }
        Update: {
          amount_minor?: number | null
          created_at?: string
          currency?: string | null
          ends_at?: string
          expired_at?: string | null
          id?: string
          plan?: string
          product?: string
          refunded_at?: string | null
          reminder_queued_at?: string | null
          starts_at?: string
          status?: string
          stripe_checkout_session_id?: string
          stripe_payment_intent_id?: string | null
          user_id?: string
        }
        Relationships: []
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
          referral_personal_until: string | null
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
          referral_personal_until?: string | null
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
          referral_personal_until?: string | null
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
          deleted_at: string | null
          display_name: string | null
          email: string
          id: string
          marketing_consent_at: string | null
          marketing_consent_source: string | null
          sso_provider_id: string | null
          unsubscribe_token: string
          unsubscribed_at: string | null
          unsubscribed_categories: string[]
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          deleted_at?: string | null
          display_name?: string | null
          email: string
          id: string
          marketing_consent_at?: string | null
          marketing_consent_source?: string | null
          sso_provider_id?: string | null
          unsubscribe_token?: string
          unsubscribed_at?: string | null
          unsubscribed_categories?: string[]
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          deleted_at?: string | null
          display_name?: string | null
          email?: string
          id?: string
          marketing_consent_at?: string | null
          marketing_consent_source?: string | null
          sso_provider_id?: string | null
          unsubscribe_token?: string
          unsubscribed_at?: string | null
          unsubscribed_categories?: string[]
          updated_at?: string
        }
        Relationships: []
      }
      webhook_deliveries: {
        Row: {
          attempt: number
          created_at: string
          delivered_at: string | null
          endpoint_id: string
          error_code: string | null
          event_id: string
          event_type: string
          id: string
          inbox_id: string | null
          last_attempt_at: string | null
          lease_id: string | null
          leased_until: string | null
          message_count: number
          message_ids: string[] | null
          next_attempt_at: string | null
          response_code: number | null
          status: string
          workspace_id: string
        }
        Insert: {
          attempt?: number
          created_at?: string
          delivered_at?: string | null
          endpoint_id: string
          error_code?: string | null
          event_id: string
          event_type: string
          id?: string
          inbox_id?: string | null
          last_attempt_at?: string | null
          lease_id?: string | null
          leased_until?: string | null
          message_count?: number
          message_ids?: string[] | null
          next_attempt_at?: string | null
          response_code?: number | null
          status?: string
          workspace_id: string
        }
        Update: {
          attempt?: number
          created_at?: string
          delivered_at?: string | null
          endpoint_id?: string
          error_code?: string | null
          event_id?: string
          event_type?: string
          id?: string
          inbox_id?: string | null
          last_attempt_at?: string | null
          lease_id?: string | null
          leased_until?: string | null
          message_count?: number
          message_ids?: string[] | null
          next_attempt_at?: string | null
          response_code?: number | null
          status?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhook_deliveries_endpoint_id_fkey"
            columns: ["endpoint_id"]
            isOneToOne: false
            referencedRelation: "webhook_endpoints"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "webhook_deliveries_inbox_id_fkey"
            columns: ["inbox_id"]
            isOneToOne: false
            referencedRelation: "inboxes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "webhook_deliveries_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "webhook_deliveries_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      webhook_endpoints: {
        Row: {
          consecutive_failures: number
          created_at: string
          created_by: string | null
          disabled_at: string | null
          disabled_reason: string | null
          events: string[]
          failing_since: string | null
          id: string
          inbox_ids: string[] | null
          last_success_at: string | null
          payload_mode: string
          secret_ciphertext: string
          secret_prefix: string
          updated_at: string
          url: string
          workspace_id: string
        }
        Insert: {
          consecutive_failures?: number
          created_at?: string
          created_by?: string | null
          disabled_at?: string | null
          disabled_reason?: string | null
          events?: string[]
          failing_since?: string | null
          id?: string
          inbox_ids?: string[] | null
          last_success_at?: string | null
          payload_mode?: string
          secret_ciphertext: string
          secret_prefix: string
          updated_at?: string
          url: string
          workspace_id: string
        }
        Update: {
          consecutive_failures?: number
          created_at?: string
          created_by?: string | null
          disabled_at?: string | null
          disabled_reason?: string | null
          events?: string[]
          failing_since?: string | null
          id?: string
          inbox_ids?: string[] | null
          last_success_at?: string | null
          payload_mode?: string
          secret_ciphertext?: string
          secret_prefix?: string
          updated_at?: string
          url?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhook_endpoints_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "webhook_endpoints_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "billing_funnel_by_workspace"
            referencedColumns: ["workspace_id"]
          },
          {
            foreignKeyName: "webhook_endpoints_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
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
          acquisition_country: string | null
          acquisition_device: string | null
          acquisition_email_segment: string | null
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
          bulk_undo_hidden: boolean
          card_diagnostics: boolean
          chat_checkout_link_enabled: boolean
          chat_send_confirm_enabled: boolean
          created_at: string
          deleted_at: string | null
          display_name: string
          draft_editor_enabled: boolean
          draft_editor_hidden: boolean
          free_action_cap_exempt: boolean
          grace_end_note_seen_at: string | null
          grandfathered: boolean
          id: string
          inbox_swapped_at: string | null
          onboarding_client: string | null
          onboarding_client_selected_at: string | null
          onboarding_completed_at: string | null
          onboarding_connection_verified_at: string | null
          onboarding_credential_issued_at: string | null
          onboarding_inbox_connected_at: string | null
          onboarding_provider: string | null
          onboarding_reset_at: string | null
          onboarding_stage: string
          onboarding_started_at: string | null
          onboarding_technical_activated_at: string | null
          onboarding_value_activated_at: string | null
          onboarding_welcome_shown_at: string | null
          owner_id: string
          payment_issue_kind: string | null
          payment_issue_since: string | null
          payment_notice_shown_on: string | null
          plan: string
          plan_summary_dismissed_at: string | null
          pro_features_enabled: boolean
          pro_unlimited_inboxes_exempt: boolean
          referral_enabled: boolean
          sends_frozen_at: string | null
          slug: string
          stripe_customer_id: string | null
          subscription_cleanup_enabled: boolean
          updated_at: string
          web_client_enabled: boolean
        }
        Insert: {
          acquisition_country?: string | null
          acquisition_device?: string | null
          acquisition_email_segment?: string | null
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
          bulk_undo_hidden?: boolean
          card_diagnostics?: boolean
          chat_checkout_link_enabled?: boolean
          chat_send_confirm_enabled?: boolean
          created_at?: string
          deleted_at?: string | null
          display_name: string
          draft_editor_enabled?: boolean
          draft_editor_hidden?: boolean
          free_action_cap_exempt?: boolean
          grace_end_note_seen_at?: string | null
          grandfathered?: boolean
          id?: string
          inbox_swapped_at?: string | null
          onboarding_client?: string | null
          onboarding_client_selected_at?: string | null
          onboarding_completed_at?: string | null
          onboarding_connection_verified_at?: string | null
          onboarding_credential_issued_at?: string | null
          onboarding_inbox_connected_at?: string | null
          onboarding_provider?: string | null
          onboarding_reset_at?: string | null
          onboarding_stage?: string
          onboarding_started_at?: string | null
          onboarding_technical_activated_at?: string | null
          onboarding_value_activated_at?: string | null
          onboarding_welcome_shown_at?: string | null
          owner_id: string
          payment_issue_kind?: string | null
          payment_issue_since?: string | null
          payment_notice_shown_on?: string | null
          plan?: string
          plan_summary_dismissed_at?: string | null
          pro_features_enabled?: boolean
          pro_unlimited_inboxes_exempt?: boolean
          referral_enabled?: boolean
          sends_frozen_at?: string | null
          slug: string
          stripe_customer_id?: string | null
          subscription_cleanup_enabled?: boolean
          updated_at?: string
          web_client_enabled?: boolean
        }
        Update: {
          acquisition_country?: string | null
          acquisition_device?: string | null
          acquisition_email_segment?: string | null
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
          bulk_undo_hidden?: boolean
          card_diagnostics?: boolean
          chat_checkout_link_enabled?: boolean
          chat_send_confirm_enabled?: boolean
          created_at?: string
          deleted_at?: string | null
          display_name?: string
          draft_editor_enabled?: boolean
          draft_editor_hidden?: boolean
          free_action_cap_exempt?: boolean
          grace_end_note_seen_at?: string | null
          grandfathered?: boolean
          id?: string
          inbox_swapped_at?: string | null
          onboarding_client?: string | null
          onboarding_client_selected_at?: string | null
          onboarding_completed_at?: string | null
          onboarding_connection_verified_at?: string | null
          onboarding_credential_issued_at?: string | null
          onboarding_inbox_connected_at?: string | null
          onboarding_provider?: string | null
          onboarding_reset_at?: string | null
          onboarding_stage?: string
          onboarding_started_at?: string | null
          onboarding_technical_activated_at?: string | null
          onboarding_value_activated_at?: string | null
          onboarding_welcome_shown_at?: string | null
          owner_id?: string
          payment_issue_kind?: string | null
          payment_issue_since?: string | null
          payment_notice_shown_on?: string | null
          plan?: string
          plan_summary_dismissed_at?: string | null
          pro_features_enabled?: boolean
          pro_unlimited_inboxes_exempt?: boolean
          referral_enabled?: boolean
          sends_frozen_at?: string | null
          slug?: string
          stripe_customer_id?: string | null
          subscription_cleanup_enabled?: boolean
          updated_at?: string
          web_client_enabled?: boolean
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
      _app_base_url: { Args: never; Returns: string }
      _functions_base_url: { Args: never; Returns: string }
      accept_workspace_invite: {
        Args: { p_token_hash: string }
        Returns: {
          role: string
          workspace_id: string
          workspace_slug: string
        }[]
      }
      activation_segments: {
        Args: { days?: number }
        Returns: {
          segment: string
          segment_index: number
          total_workspaces: number
          workspaces: number
        }[]
      }
      activity_log_retention_preview: {
        Args: { p_min_days?: number }
        Returns: {
          plan: string
          rows_kept_by_audit_floor: number
          rows_to_delete: number
          rows_total: number
          window_days: number
        }[]
      }
      activity_log_retention_window_days: {
        Args: { p_plan: string }
        Returns: number
      }
      activity_log_retention_workspace_windows: {
        Args: never
        Returns: {
          days: number
          plan: string
          workspace_id: string
        }[]
      }
      activity_log_tool_is_read_only: {
        Args: { p_tool: string }
        Returns: boolean
      }
      auth_azure_email_verified: { Args: { p_data: Json }; Returns: boolean }
      auth_hook_before_user_created: { Args: { event: Json }; Returns: Json }
      auth_hook_custom_access_token: { Args: { event: Json }; Returns: Json }
      auth_hook_switch_on: { Args: { p_name: string }; Returns: boolean }
      auth_signup_refusal: { Args: { p_user: Json }; Returns: string }
      auth_token_refusal: {
        Args: { p_authentication_method: string; p_user_id: string }
        Returns: string
      }
      checkout_link_attach_session: {
        Args: {
          p_id: string
          p_session_expires_at: string
          p_session_id: string
        }
        Returns: string
      }
      checkout_link_complete: { Args: { p_id: string }; Returns: undefined }
      checkout_link_issue: {
        Args: {
          p_blocked_tool: string
          p_client_label: string
          p_id: string
          p_owner_user_id: string
          p_token_hash: string
          p_ttl_minutes?: number
          p_variant: string
          p_workspace_id: string
        }
        Returns: {
          expires_at: string
          id: string
          reused: boolean
        }[]
      }
      checkout_link_open: {
        Args: { p_token_hash: string }
        Returns: {
          billing_interval: string
          client_label: string
          completed_at: string
          expires_at: string
          first_open: boolean
          id: string
          owner_user_id: string
          plan_id: string
          stripe_session_expires_at: string
          stripe_session_id: string
          workspace_id: string
        }[]
      }
      checkout_link_readout: {
        Args: { p_since?: string }
        Returns: {
          checkout_sessions: number
          client_label: string
          completed: number
          links: number
          opened: number
          resumed: number
          variant: string
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
          recovered_by: string | null
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
      claim_onboarding_welcome: {
        Args: { p_workspace_id: string }
        Returns: boolean
      }
      claim_usage_meter_note: {
        Args: {
          p_level: number
          p_period_start: string
          p_workspace_id: string
        }
        Returns: boolean
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
      dispatch_activation_help: { Args: never; Returns: undefined }
      dispatch_billing_lifecycle: {
        Args: { p_mode?: string }
        Returns: undefined
      }
      dispatch_black_week_email: { Args: never; Returns: undefined }
      dispatch_eur_launch: { Args: never; Returns: undefined }
      dispatch_first_30_days: { Args: never; Returns: undefined }
      dispatch_inbox_watch: { Args: never; Returns: undefined }
      dispatch_morning_briefs: { Args: never; Returns: undefined }
      dispatch_onboarding_morning_brief: { Args: never; Returns: undefined }
      dispatch_pass_expiry: { Args: never; Returns: undefined }
      dispatch_paywall_followup: { Args: never; Returns: undefined }
      dispatch_pro_price_notice: { Args: never; Returns: undefined }
      dispatch_referrals: { Args: never; Returns: undefined }
      dispatch_reminders: { Args: never; Returns: undefined }
      dispatch_scheduled_sends: { Args: never; Returns: undefined }
      dispatch_site_feed: { Args: { p_job: string }; Returns: undefined }
      dispatch_subscription_followup: { Args: never; Returns: undefined }
      dispatch_triage_rules: { Args: never; Returns: undefined }
      draft_lineage_record: {
        Args: {
          p_adopt?: boolean
          p_draft_id: string
          p_expected_revision?: number
          p_inbox_id: string
          p_line_id?: string
          p_seed_draft_id?: string
          p_workspace_id: string
          p_written_at?: string
          p_written_by: string
        }
        Returns: {
          contended: boolean
          recorded_line_id: string
          recorded_revision: number
        }[]
      }
      effective_workspace_plan: {
        Args: { p_workspace_id: string }
        Returns: {
          comped_scale: boolean
          plan: string
          pro_unlimited_inboxes: boolean
          referral_personal: boolean
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
      finalize_assistant_run: {
        Args: {
          p_cost_micro_usd: number
          p_input_tokens: number
          p_model: string
          p_output_tokens: number
          p_reservation_id: string
        }
        Returns: boolean
      }
      free_action_grace_ends_at: {
        Args: { p_created_at: string }
        Returns: string
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
      grant_referral_personal: {
        Args: { p_days?: number; p_reason?: string; p_user_id: string }
        Returns: string
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
      growth_activity_rollup_refresh: {
        Args: { p_from?: string }
        Returns: number
      }
      growth_client_family: { Args: { p_client_name: string }; Returns: string }
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
      growth_draft_card_daily: {
        Args: {
          p_days: number
          p_internal_domains?: string[]
          p_internal_emails?: string[]
        }
        Returns: {
          day: string
          drafted: number
          hidden: number
          saved: number
          sent_agent: number
          sent_card: number
        }[]
      }
      growth_draft_card_reach: {
        Args: { p_internal_domains?: string[]; p_internal_emails?: string[] }
        Returns: {
          enabled: number
          enabled_inboxes: number
          hidden_inboxes: number
          hidden_workspaces: number
          workspaces: number
        }[]
      }
      growth_draft_card_stats: {
        Args: {
          p_days: number
          p_internal_domains?: string[]
          p_internal_emails?: string[]
          p_release_at?: string
        }
        Returns: {
          calls: number
          card_workspaces: number
          deleted_agent: number
          deleted_card: number
          drafted: number
          drafted_card: number
          eligible_card: number
          eligible_plain: number
          errors: number
          family: string
          hidden: number
          lines: number
          lines_listed: number
          mature_lines: number
          mature_listed: number
          period: string
          returned_card: number
          returned_plain: number
          saved: number
          sent_agent: number
          sent_card: number
          w_calls: number
          w_deleted: number
          w_errors: number
          w_lines: number
          w_lines_listed: number
          w_mature: number
          w_mature_listed: number
          w_sent_day: number
          w_sent_day_listed: number
          w_touched: number
          w_touched_listed: number
          workspaces: number
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
      growth_mail_relay_daily: {
        Args: { p_days: number }
        Returns: {
          day: string
          host_refused: number
          ok: number
          relay_down: number
        }[]
      }
      growth_mail_relay_hosts: {
        Args: { p_days: number }
        Returns: {
          avg_ms: number
          candidate_direct_successes: number
          candidate_refused: boolean
          candidate_rescues: number
          connections: number
          first_learned_at: string
          host: string
          host_refused: number
          last_at: string
          last_failure: string
          last_failure_at: string
          learned: boolean
          learned_expires_at: string
          learned_source: string
          ok: number
          protocol: string
          relay_down: number
          routes: string
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
      growth_onboarding_arms: {
        Args: { p_internal_domains?: string[]; p_internal_emails?: string[] }
        Returns: {
          assigned: number
          completed: number
          connect_failed_ws: number
          connect_ws: number
          convert: string
          draft_3d: number
          first_assigned_at: string
          flow: string
          habit_7d: number
          inbox_1d: number
          mature_1d: number
          mature_30d: number
          mature_3d: number
          mature_7d: number
          paid_30d: number
          paid_any: number
          value_1d: number
        }[]
      }
      growth_onboarding_daily: {
        Args: {
          p_days: number
          p_internal_domains?: string[]
          p_internal_emails?: string[]
        }
        Returns: {
          convert_off: number
          convert_on: number
          created: number
          day: string
          flow_control: number
          flow_new: number
          mature_1d: number
          value_1d: number
        }[]
      }
      growth_onboarding_steps: {
        Args: { p_internal_domains?: string[]; p_internal_emails?: string[] }
        Returns: {
          category: string
          convert: string
          flow: string
          stage: string
          workspaces: number
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
      growth_signup_pace: {
        Args: {
          p_days?: number
          p_internal_domains?: string[]
          p_internal_emails?: string[]
        }
        Returns: {
          as_of: string
          by_now: number
          day: string
          new_users: number
        }[]
      }
      growth_signup_trend: {
        Args: {
          p_internal_domains?: string[]
          p_internal_emails?: string[]
          p_weeks?: number
        }
        Returns: {
          as_of: string
          by_now: number
          week_start: string
          workspaces: number
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
      growth_window_sessions: {
        Args: { p_first_starts: boolean[]; p_starts: number[] }
        Returns: number
      }
      inbox_autofill_scoreboard: {
        Args: { p_days?: number }
        Returns: {
          lookups: number
          result: string
          source: string
          suggested: boolean
          surface: string
        }[]
      }
      inbox_folder_overrides_valid: {
        Args: { overrides: Json }
        Returns: boolean
      }
      internal_account_domains: { Args: never; Returns: string[] }
      internal_account_emails: { Args: never; Returns: string[] }
      invoke_outlook_token_refresh: { Args: never; Returns: undefined }
      invoke_synthetic_monitor: {
        Args: { controlled_failure?: boolean; mode: string }
        Returns: undefined
      }
      learn_mail_relay_host: {
        Args: {
          p_host: string
          p_protocol: string
          p_reason: string
          p_runtime: string
        }
        Returns: boolean
      }
      lease_inbox_watches: {
        Args: { p_lease_seconds?: number; p_limit?: number }
        Returns: {
          failure_count: number
          folders: Json
          inbox_id: string
          inbox_last_error: string
          last_checked_at: string
          lease_id: string
          mail_host: string
          provider: string
          workspace_id: string
        }[]
      }
      lease_webhook_deliveries: {
        Args: { p_lease_seconds?: number; p_limit?: number }
        Returns: {
          attempt: number
          backoff_until: string
          created_at: string
          delivery_id: string
          endpoint_enabled: boolean
          endpoint_id: string
          event_id: string
          inbox_id: string
          inbox_last_error: string
          lease_id: string
          mail_host: string
          message_count: number
          message_ids: string[]
          payload_mode: string
          plan_allowed: boolean
          provider: string
          secret_ciphertext: string
          url: string
          workspace_id: string
        }[]
      }
      mark_synthetic_monitor_incident_alerted: {
        Args: { p_incident_id: string }
        Returns: undefined
      }
      mark_synthetic_monitor_recovery_alerted: {
        Args: { p_incident_id: string }
        Returns: undefined
      }
      mcp_tools_call_gate: {
        Args: {
          p_include_allowance: boolean
          p_key_hash: string
          p_key_window_starts: string[]
          p_meter_version: number
          p_reserve_tool_name: string
          p_workspace_window_start: string
        }
        Returns: Json
      }
      mcp_tools_call_preflight: {
        Args: {
          p_include_allowance: boolean
          p_key_hash: string
          p_key_window_starts: string[]
          p_workspace_window_start: string
        }
        Returns: Json
      }
      my_referral_summary: {
        Args: never
        Returns: {
          attached_at: string
          entitlement_until: string
          id: string
          qualified_at: string
          qualifies_at: string
          reward_cents: number
          reward_kind: string
          status: string
        }[]
      }
      my_workspace_ids: { Args: never; Returns: string[] }
      onboarding_convert_on: {
        Args: { p_workspace_id: string }
        Returns: boolean
      }
      outbound_send_gate: {
        Args: {
          p_commit: boolean
          p_content_hash: string
          p_daily_limit: number
          p_fanout_limit: number
          p_fanout_window_ms: number
          p_human_approved: boolean
          p_inbox_id: string
          p_messages: number
          p_recipient_hashes: string[]
          p_workspace_id: string
        }
        Returns: Json
      }
      outbound_send_refusal: {
        Args: {
          p_inbox_id: string
          p_pause_ms: number
          p_threshold: number
          p_window_ms: number
          p_workspace_id: string
        }
        Returns: Json
      }
      purge_activity_log_batch: {
        Args: { p_limit?: number; p_min_days?: number }
        Returns: number
      }
      purge_deleted_accounts: { Args: never; Returns: Json }
      purge_disconnected_inboxes: { Args: never; Returns: Json }
      purge_operational_history: { Args: never; Returns: Json }
      purge_outbound_send_events: { Args: never; Returns: Json }
      purge_send_history: { Args: never; Returns: Json }
      push_recipients: {
        Args: { p_inbox_id: string }
        Returns: {
          auth: string
          endpoint: string
          p256dh: string
          payload_mode: string
          quiet_end: number
          quiet_start: number
          quiet_timezone: string
          subscription_id: string
          user_id: string
        }[]
      }
      rate_limit_check: {
        Args: { p_key: string; p_max_count: number; p_window_ms: number }
        Returns: boolean
      }
      record_business_founder_place: {
        Args: {
          p_interval: string
          p_owner_id: string
          p_subscription_id: string
        }
        Returns: boolean
      }
      record_inbox_cap_event: {
        Args: {
          p_cap: number
          p_inbox_count: number
          p_plan: string
          p_workspace_id: string
        }
        Returns: undefined
      }
      record_mail_relay_use: {
        Args: {
          p_detail?: string
          p_host: string
          p_ms: number
          p_outcome: string
          p_protocol: string
          p_route: string
          p_runtime: string
        }
        Returns: undefined
      }
      record_push_results: {
        Args: { p_failed: string[]; p_gone: string[]; p_sent: string[] }
        Returns: undefined
      }
      record_signup_marketing_consent: {
        Args: { p_source: string; p_user_id: string }
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
      record_webhook_attempt: {
        Args: {
          p_abandon_code?: string
          p_delivery_id: string
          p_error_code: string
          p_lease_id: string
          p_max_failing_seconds: number
          p_max_failures: number
          p_next_at: string
          p_ok: boolean
          p_response_code: number
        }
        Returns: {
          endpoint_disabled: boolean
          endpoint_id: string
        }[]
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
      reserve_assistant_run: {
        Args: { p_user_id: string; p_workspace_id: string }
        Returns: {
          allowed: boolean
          cap: number
          max_tokens_per_run: number
          period_end: string
          period_start: string
          plan: string
          remaining: number
          reservation_id: string
          used: number
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
      scheduled_sends_operator_workspace_ids: { Args: never; Returns: string[] }
      scrub_legacy_activity_log_client_info: {
        Args: { p_blocks?: number }
        Returns: Json
      }
      signup_method_category: { Args: { p_provider: string }; Returns: string }
      signup_scoreboard: {
        Args: never
        Returns: {
          internal_excluded: number
          last_24h: number
          last_7d: number
          total: number
        }[]
      }
      site_feed_emails_handled: {
        Args: { p_internal_emails?: string[] }
        Returns: number
      }
      sso_admin_test_sign_in_seen: {
        Args: { p_connection_id: string }
        Returns: boolean
      }
      sso_admin_workspace_ids: { Args: never; Returns: string[] }
      sso_enforced_connection_for_email: {
        Args: { p_email: string }
        Returns: {
          connection_id: string
          owner_id: string
          supabase_sso_provider_id: string
          workspace_id: string
        }[]
      }
      sso_is_consumer_domain: { Args: { p_domain: string }; Returns: boolean }
      sso_provider_for_domain: { Args: { p_domain: string }; Returns: string }
      sso_sign_in_required: { Args: { p_email: string }; Returns: boolean }
      sync_inbox_watch_state: { Args: never; Returns: undefined }
      try_timestamptz: { Args: { p_value: string }; Returns: string }
      usage_month_summary: {
        Args: { p_since: string; p_workspace_id: string }
        Returns: {
          drafts: number
          reads: number
          sends: number
        }[]
      }
      user_active_pass: {
        Args: { p_user: string }
        Returns: {
          ends_at: string
        }[]
      }
      webhook_capped_inboxes: {
        Args: { p_workspace_id?: string }
        Returns: {
          inbox_id: string
          workspace_id: string
        }[]
      }
      webhook_enqueue_event: {
        Args: {
          p_event_id: string
          p_inbox_id: string
          p_message_count: number
          p_message_ids: string[]
        }
        Returns: number
      }
      webhook_has_targets: { Args: { p_inbox_id: string }; Returns: boolean }
      webhooks_plan_allowed: {
        Args: { p_workspace_id: string }
        Returns: boolean
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
      workspace_action_allowance_terms: {
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
      workspace_assistant_allowance: {
        Args: { p_workspace_id: string }
        Returns: {
          cap: number
          cost_micro_usd: number
          input_tokens: number
          max_tokens_per_run: number
          output_tokens: number
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
      workspace_pro_features: {
        Args: { p_workspace_id: string }
        Returns: {
          comped_scale: boolean
          plan: string
          public_launch: boolean
          rollout_enabled: boolean
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
