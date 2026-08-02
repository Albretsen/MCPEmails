export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      activity_log: {
        Row: {
          api_key_id: string | null
          created_at: string
          duration_ms: number | null
          error_code: string | null
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
      api_keys: {
        Row: {
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
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      inboxes: {
        Row: {
          created_at: string
          deleted_at: string | null
          display_name: string | null
          email_address: string
          id: string
          imap_host: string | null
          imap_password: string | null
          imap_port: number | null
          imap_tls: boolean
          imap_username: string | null
          last_error: string | null
          last_sync_at: string | null
          oauth_access_token: string | null
          oauth_refresh_token: string | null
          oauth_scope: string | null
          oauth_token_expires_at: string | null
          provider: string
          service: string | null
          signature_enabled: boolean
          signature_html: string | null
          signature_reply_mode: string
          signature_source: string | null
          signature_text: string | null
          signature_updated_at: string | null
          smtp_host: string | null
          smtp_port: number | null
          smtp_tls: boolean
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          display_name?: string | null
          email_address: string
          id?: string
          imap_host?: string | null
          imap_password?: string | null
          imap_port?: number | null
          imap_tls?: boolean
          imap_username?: string | null
          last_error?: string | null
          last_sync_at?: string | null
          oauth_access_token?: string | null
          oauth_refresh_token?: string | null
          oauth_scope?: string | null
          oauth_token_expires_at?: string | null
          provider: string
          service?: string | null
          signature_enabled?: boolean
          signature_html?: string | null
          signature_reply_mode?: string
          signature_source?: string | null
          signature_text?: string | null
          signature_updated_at?: string | null
          smtp_host?: string | null
          smtp_port?: number | null
          smtp_tls?: boolean
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          display_name?: string | null
          email_address?: string
          id?: string
          imap_host?: string | null
          imap_password?: string | null
          imap_port?: number | null
          imap_tls?: boolean
          imap_username?: string | null
          last_error?: string | null
          last_sync_at?: string | null
          oauth_access_token?: string | null
          oauth_refresh_token?: string | null
          oauth_scope?: string | null
          oauth_token_expires_at?: string | null
          provider?: string
          service?: string | null
          signature_enabled?: boolean
          signature_html?: string | null
          signature_reply_mode?: string
          signature_source?: string | null
          signature_text?: string | null
          signature_updated_at?: string | null
          smtp_host?: string | null
          smtp_port?: number | null
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
          scopes?: string[]
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
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
      users: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          email: string
          id: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          email: string
          id: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          email?: string
          id?: string
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
      user_billing: {
        Row: {
          created_at: string
          current_period_end: string | null
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
      workspaces: {
        Row: {
          acquisition_landing: string | null
          acquisition_source: string | null
          analytics_first_tool_client: string | null
          analytics_first_tool_name: string | null
          analytics_first_tool_path: string | null
          analytics_first_tool_provider: string | null
          analytics_first_tool_reported_at: string | null
          analytics_first_inbox_connected_at: string | null
          analytics_first_inbox_provider: string | null
          analytics_first_credential_created_at: string | null
          analytics_first_credential_method: string | null
          analytics_first_tool_used_at: string | null
          created_at: string
          deleted_at: string | null
          display_name: string
          grandfathered: boolean
          id: string
          owner_id: string
          plan: string
          slug: string
          stripe_customer_id: string | null
          updated_at: string
        }
        Insert: {
          acquisition_landing?: string | null
          acquisition_source?: string | null
          analytics_first_tool_client?: string | null
          analytics_first_tool_name?: string | null
          analytics_first_tool_path?: string | null
          analytics_first_tool_provider?: string | null
          analytics_first_tool_reported_at?: string | null
          analytics_first_inbox_connected_at?: string | null
          analytics_first_inbox_provider?: string | null
          analytics_first_credential_created_at?: string | null
          analytics_first_credential_method?: string | null
          analytics_first_tool_used_at?: string | null
          created_at?: string
          deleted_at?: string | null
          display_name: string
          grandfathered?: boolean
          id?: string
          owner_id: string
          plan?: string
          slug: string
          stripe_customer_id?: string | null
          updated_at?: string
        }
        Update: {
          acquisition_landing?: string | null
          acquisition_source?: string | null
          analytics_first_tool_client?: string | null
          analytics_first_tool_name?: string | null
          analytics_first_tool_path?: string | null
          analytics_first_tool_provider?: string | null
          analytics_first_tool_reported_at?: string | null
          analytics_first_inbox_connected_at?: string | null
          analytics_first_inbox_provider?: string | null
          analytics_first_credential_created_at?: string | null
          analytics_first_credential_method?: string | null
          analytics_first_tool_used_at?: string | null
          created_at?: string
          deleted_at?: string | null
          display_name?: string
          grandfathered?: boolean
          id?: string
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
      [_ in never]: never
    }
    Functions: {
      accept_workspace_invite: {
        Args: { p_token_hash: string; p_user_email: string; p_user_id: string }
        Returns: {
          role: string
          workspace_id: string
          workspace_slug: string
        }[]
      }
      ensure_activity_log_partitions: {
        Args: { months_ahead?: number }
        Returns: undefined
      }
      expire_workspace_invites: { Args: never; Returns: undefined }
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
      my_workspace_ids: { Args: never; Returns: string[] }
      revoke_user_session: {
        Args: { p_session_id: string }
        Returns: {
          revoked_session_id: string
        }[]
      }
      rate_limit_check: {
        Args: { p_key: string; p_max_count: number; p_window_ms: number }
        Returns: boolean
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
