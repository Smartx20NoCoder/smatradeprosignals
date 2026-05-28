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
  public: {
    Tables: {
      api_usage: {
        Row: {
          calls: number
          day: string
          updated_at: string
        }
        Insert: {
          calls?: number
          day: string
          updated_at?: string
        }
        Update: {
          calls?: number
          day?: string
          updated_at?: string
        }
        Relationships: []
      }
      app_settings: {
        Row: {
          active_td_key: number
          id: string
          key1_exhausted_at: string | null
          metaapi_account_id: string | null
          metaapi_auto_trade: boolean
          metaapi_connected_at: string | null
          metaapi_fixed_lot: number
          metaapi_min_confidence: number
          metaapi_min_rr: number
          metaapi_region: string
          paused: boolean
          session_config: Json
          trading_hours_end_utc: number
          trading_hours_start_utc: number
          updated_at: string
        }
        Insert: {
          active_td_key?: number
          id?: string
          key1_exhausted_at?: string | null
          metaapi_account_id?: string | null
          metaapi_auto_trade?: boolean
          metaapi_connected_at?: string | null
          metaapi_fixed_lot?: number
          metaapi_min_confidence?: number
          metaapi_min_rr?: number
          metaapi_region?: string
          paused?: boolean
          session_config?: Json
          trading_hours_end_utc?: number
          trading_hours_start_utc?: number
          updated_at?: string
        }
        Update: {
          active_td_key?: number
          id?: string
          key1_exhausted_at?: string | null
          metaapi_account_id?: string | null
          metaapi_auto_trade?: boolean
          metaapi_connected_at?: string | null
          metaapi_fixed_lot?: number
          metaapi_min_confidence?: number
          metaapi_min_rr?: number
          metaapi_region?: string
          paused?: boolean
          session_config?: Json
          trading_hours_end_utc?: number
          trading_hours_start_utc?: number
          updated_at?: string
        }
        Relationships: []
      }
      candle_cache: {
        Row: {
          candles: Json
          fetched_at: string
          id: string
          pair: string
          timeframe: string
        }
        Insert: {
          candles: Json
          fetched_at?: string
          id?: string
          pair: string
          timeframe: string
        }
        Update: {
          candles?: Json
          fetched_at?: string
          id?: string
          pair?: string
          timeframe?: string
        }
        Relationships: []
      }
      economic_events: {
        Row: {
          currency: string
          event_time: string
          fetched_at: string
          id: string
          impact: string
          source: string | null
          title: string
        }
        Insert: {
          currency: string
          event_time: string
          fetched_at?: string
          id?: string
          impact: string
          source?: string | null
          title: string
        }
        Update: {
          currency?: string
          event_time?: string
          fetched_at?: string
          id?: string
          impact?: string
          source?: string | null
          title?: string
        }
        Relationships: []
      }
      scan_runs: {
        Row: {
          api_calls_today: number
          api_calls_used: number
          errors: Json
          finished_at: string | null
          id: string
          mode: string
          new_signals: number
          ok: boolean
          source: string
          started_at: string
        }
        Insert: {
          api_calls_today?: number
          api_calls_used?: number
          errors?: Json
          finished_at?: string | null
          id?: string
          mode?: string
          new_signals?: number
          ok?: boolean
          source?: string
          started_at?: string
        }
        Update: {
          api_calls_today?: number
          api_calls_used?: number
          errors?: Json
          finished_at?: string | null
          id?: string
          mode?: string
          new_signals?: number
          ok?: boolean
          source?: string
          started_at?: string
        }
        Relationships: []
      }
      signals: {
        Row: {
          atr: number | null
          candle_time: string | null
          closed_at: string | null
          confidence: number
          created_at: string
          direction: string
          entry: number
          executed_at: string | null
          htf_bias: string | null
          id: string
          metaapi_execution_error: string | null
          metaapi_execution_status: string
          metaapi_filled_price: number | null
          metaapi_order_id: string | null
          metaapi_pnl: number | null
          metaapi_position_id: string | null
          mfi_divergence: boolean
          mfi_score: number | null
          news_flag: boolean
          notes: string | null
          order_type: string | null
          outcome_r: number | null
          pair: string
          partial_close: boolean
          rr: number
          session_score: number
          setup: string
          spread_pips: number | null
          status: string
          stop_loss: number
          timeframe: string
          tp1: number
          tp2: number
        }
        Insert: {
          atr?: number | null
          candle_time?: string | null
          closed_at?: string | null
          confidence: number
          created_at?: string
          direction: string
          entry: number
          executed_at?: string | null
          htf_bias?: string | null
          id?: string
          metaapi_execution_error?: string | null
          metaapi_execution_status?: string
          metaapi_filled_price?: number | null
          metaapi_order_id?: string | null
          metaapi_pnl?: number | null
          metaapi_position_id?: string | null
          mfi_divergence?: boolean
          mfi_score?: number | null
          news_flag?: boolean
          notes?: string | null
          order_type?: string | null
          outcome_r?: number | null
          pair: string
          partial_close?: boolean
          rr: number
          session_score: number
          setup: string
          spread_pips?: number | null
          status?: string
          stop_loss: number
          timeframe: string
          tp1: number
          tp2: number
        }
        Update: {
          atr?: number | null
          candle_time?: string | null
          closed_at?: string | null
          confidence?: number
          created_at?: string
          direction?: string
          entry?: number
          executed_at?: string | null
          htf_bias?: string | null
          id?: string
          metaapi_execution_error?: string | null
          metaapi_execution_status?: string
          metaapi_filled_price?: number | null
          metaapi_order_id?: string | null
          metaapi_pnl?: number | null
          metaapi_position_id?: string | null
          mfi_divergence?: boolean
          mfi_score?: number | null
          news_flag?: boolean
          notes?: string | null
          order_type?: string | null
          outcome_r?: number | null
          pair?: string
          partial_close?: boolean
          rr?: number
          session_score?: number
          setup?: string
          spread_pips?: number | null
          status?: string
          stop_loss?: number
          timeframe?: string
          tp1?: number
          tp2?: number
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
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
