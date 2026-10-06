export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: '14.5'
  }
  public: {
    Tables: {
      batches: {
        Row: {
          created_at: string
          defect_confidence: number | null
          defect_flag: boolean | null
          id: number
          order_id: number
          photo_public_id: string | null
          photo_url: string | null
          reported_pdf_public_id: string | null
          reported_pdf_url: string | null
          supplier_id: number
          vlm_description: string | null
        }
        Insert: {
          created_at?: string
          defect_confidence?: number | null
          defect_flag?: boolean | null
          id?: never
          order_id: number
          photo_public_id?: string | null
          photo_url?: string | null
          reported_pdf_public_id?: string | null
          reported_pdf_url?: string | null
          supplier_id: number
          vlm_description?: string | null
        }
        Update: {
          created_at?: string
          defect_confidence?: number | null
          defect_flag?: boolean | null
          id?: never
          order_id?: number
          photo_public_id?: string | null
          photo_url?: string | null
          reported_pdf_public_id?: string | null
          reported_pdf_url?: string | null
          supplier_id?: number
          vlm_description?: string | null
        }
        Relationships: []
      }
      decisions: {
        Row: {
          created_at: string
          decision_text: string
          id: number
          made_by: Database['public']['Enums']['decision_maker']
          reasoning: string
          related_entity_id: number
          related_entity_type: string
        }
        Insert: {
          created_at?: string
          decision_text: string
          id?: never
          made_by: Database['public']['Enums']['decision_maker']
          reasoning: string
          related_entity_id: number
          related_entity_type: string
        }
        Update: {
          created_at?: string
          decision_text?: string
          id?: never
          made_by?: Database['public']['Enums']['decision_maker']
          reasoning?: string
          related_entity_id?: number
          related_entity_type?: string
        }
        Relationships: []
      }
      disruptions: {
        Row: {
          id: number
          magnitude: number
          resolved_at: string | null
          run_id: string | null
          supplier_id: number
          triggered_at: string
          type: Database['public']['Enums']['disruption_type']
        }
        Insert: {
          id?: never
          magnitude: number
          resolved_at?: string | null
          run_id?: string | null
          supplier_id: number
          triggered_at?: string
          type: Database['public']['Enums']['disruption_type']
        }
        Update: {
          id?: never
          magnitude?: number
          resolved_at?: string | null
          run_id?: string | null
          supplier_id?: number
          triggered_at?: string
          type?: Database['public']['Enums']['disruption_type']
        }
        Relationships: []
      }
      messages: {
        Row: {
          id: number
          thread_id: string
          sender_id: string
          sender_role: Database['public']['Enums']['app_role']
          body: string | null
          voice_url: string | null
          transcript: string | null
          mentions_supplement: boolean
          flagged_for_dashboard: boolean
          classification_status: Database['public']['Enums']['classification_status']
          created_at: string
        }
        Insert: {
          id?: never
          thread_id: string
          sender_id: string
          sender_role: Database['public']['Enums']['app_role']
          body?: string | null
          voice_url?: string | null
          transcript?: string | null
          mentions_supplement?: boolean
          flagged_for_dashboard?: boolean
          classification_status?: Database['public']['Enums']['classification_status']
          created_at?: string
        }
        Update: {
          id?: never
          thread_id?: string
          sender_id?: string
          sender_role?: Database['public']['Enums']['app_role']
          body?: string | null
          voice_url?: string | null
          transcript?: string | null
          mentions_supplement?: boolean
          flagged_for_dashboard?: boolean
          classification_status?: Database['public']['Enums']['classification_status']
          created_at?: string
        }
        Relationships: []
      }
      orders: {
        Row: {
          business_id: string
          created_at: string
          id: number
          qty_allocated: number | null
          qty_ordered: number
          sku: string
          status: string
          supplier_id: number
        }
        Insert: {
          business_id: string
          created_at?: string
          id?: never
          qty_allocated?: number | null
          qty_ordered: number
          sku: string
          status: string
          supplier_id: number
        }
        Update: {
          business_id?: string
          created_at?: string
          id?: never
          qty_allocated?: number | null
          qty_ordered?: number
          sku?: string
          status?: string
          supplier_id?: number
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          role: Database['public']['Enums']['app_role']
          supplier_id: number | null
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id: string
          role: Database['public']['Enums']['app_role']
          supplier_id?: number | null
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          role?: Database['public']['Enums']['app_role']
          supplier_id?: number | null
        }
        Relationships: []
      }
      strategies: {
        Row: {
          allocation_json: Json
          created_at: string
          expected_cost: number | null
          expected_risk: number | null
          id: number
          risk_weight: number
          run_id: string
        }
        Insert: {
          allocation_json?: Json
          created_at?: string
          expected_cost?: number | null
          expected_risk?: number | null
          id?: never
          risk_weight: number
          run_id: string
        }
        Update: {
          allocation_json?: Json
          created_at?: string
          expected_cost?: number | null
          expected_risk?: number | null
          id?: never
          risk_weight?: number
          run_id?: string
        }
        Relationships: []
      }
      supplier_forecasts: {
        Row: {
          disruption_id: number | null
          forecast_date: string
          generated_at: string
          horizon_days: number
          id: number
          model_type: string
          predicted_capacity_util: number
          predicted_defect_rate: number
          predicted_lead_time: number
          predicted_price: number
          predicted_reliability: number
          supplier_id: number
          uncertainty: Json
        }
        Insert: {
          disruption_id?: number | null
          forecast_date: string
          generated_at?: string
          horizon_days: number
          id?: never
          model_type: string
          predicted_capacity_util: number
          predicted_defect_rate: number
          predicted_lead_time: number
          predicted_price: number
          predicted_reliability: number
          supplier_id: number
          uncertainty?: Json
        }
        Update: {
          disruption_id?: number | null
          forecast_date?: string
          generated_at?: string
          horizon_days?: number
          id?: never
          model_type?: string
          predicted_capacity_util?: number
          predicted_defect_rate?: number
          predicted_lead_time?: number
          predicted_price?: number
          predicted_reliability?: number
          supplier_id?: number
          uncertainty?: Json
        }
        Relationships: []
      }
      suppliers: {
        Row: {
          active_since: string
          category: string
          id: number
          max_capacity: number
          moq: number
          name: string
          region: string
        }
        Insert: {
          active_since: string
          category: string
          id?: never
          max_capacity: number
          moq?: number
          name: string
          region: string
        }
        Update: {
          active_since?: string
          category?: string
          id?: never
          max_capacity?: number
          moq?: number
          name?: string
          region?: string
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
      app_role: 'supplier' | 'business_owner'
      classification_status: 'pending' | 'reviewed'
      decision_maker: 'agent' | 'human'
      disruption_type: 'price' | 'capacity' | 'reliability'
      metric_source: 'synthetic' | 'observed'
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>
type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, 'public'>]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] &
        DefaultSchema['Views'])
    ? (DefaultSchema['Tables'] &
        DefaultSchema['Views'])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema['Enums']
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums']
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums'][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums']
    ? DefaultSchema['Enums'][DefaultSchemaEnumNameOrOptions]
    : never
