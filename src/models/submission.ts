import {z} from 'zod';

/**
 * Shape of a single patient submission package, mirroring the pydantic models
 * in `core.py`. Every field is optional and nullable: the harness feeds real
 * intake data where any field may be absent, and "a required field is missing"
 * is itself a policy outcome (MISSING_REQUIRED_DATA) rather than a parse error.
 *
 * Unknown keys are preserved via `.passthrough()` — the documented fields are a
 * subset of what an intake API may return, and evidence paths must be able to
 * point at whatever actually arrived.
 */

const nullableString = z.string().nullish();
const nullableNumber = z.number().nullish();

export const PatientNameSchema = z
  .object({
    given: nullableString,
    family: nullableString,
  })
  .passthrough();

export const PatientInfoSchema = z
  .object({
    id: nullableString,
    mrn: nullableString,
    name: PatientNameSchema.nullish(),
    dob: nullableString,
    sex: nullableString,
  })
  .passthrough();

export const ProcedureRiskSchema = z.enum(['LOW', 'MODERATE', 'HIGH']);
export type ProcedureRisk = z.infer<typeof ProcedureRiskSchema>;

export const ProcedureInfoSchema = z
  .object({
    case_id: nullableString,
    procedure_type: nullableString,
    // Risk arrives as a free string; anything outside the enum is treated the
    // same as absent, because the policy keys required testing off this value.
    procedure_risk: ProcedureRiskSchema.nullish().catch(null),
    procedure_date: nullableString,
    is_elective: z.boolean().nullish(),
    location: nullableString,
  })
  .passthrough();

export const VitalSchema = z
  .object({
    type: nullableString,
    systolic: nullableNumber,
    diastolic: nullableNumber,
    value_f: nullableNumber,
    date: nullableString,
    source: nullableString,
  })
  .passthrough();

export const LabResultSchema = z
  .object({
    id: nullableString,
    code: nullableString,
    display: nullableString,
    effective_at: nullableString,
    status: nullableString,
    source: nullableString,
  })
  .passthrough();

export const MedicationSchema = z
  .object({
    name: nullableString,
    // `active: null` is meaningfully different from `false` — it means the
    // intake could not determine whether the patient is currently taking it.
    active: z.boolean().nullish(),
  })
  .passthrough();

export const ConditionSchema = z
  .object({
    name: nullableString,
    active: z.boolean().nullish(),
  })
  .passthrough();

export const DocumentSchema = z
  .object({
    doc_id: nullableString,
    type: nullableString,
    date: nullableString,
    author: nullableString,
    text: nullableString,
  })
  .passthrough();

export const SubmissionMetadataSchema = z
  .object({
    submission_received_at: nullableString,
    source_system: nullableString,
  })
  .passthrough();

export const PatientSubmissionSchema = z
  .object({
    patient: PatientInfoSchema.nullish(),
    procedure: ProcedureInfoSchema.nullish(),
    vitals: z.array(VitalSchema).nullish().default([]),
    labs: z.array(LabResultSchema).nullish().default([]),
    medications: z.array(MedicationSchema).nullish().default([]),
    conditions: z.array(ConditionSchema).nullish().default([]),
    documents: z.array(DocumentSchema).nullish().default([]),
    metadata: SubmissionMetadataSchema.nullish(),
  })
  .passthrough();

export type PatientName = z.infer<typeof PatientNameSchema>;
export type PatientInfo = z.infer<typeof PatientInfoSchema>;
export type ProcedureInfo = z.infer<typeof ProcedureInfoSchema>;
export type Vital = z.infer<typeof VitalSchema>;
export type LabResult = z.infer<typeof LabResultSchema>;
export type Medication = z.infer<typeof MedicationSchema>;
export type Condition = z.infer<typeof ConditionSchema>;
export type ClinicalDocument = z.infer<typeof DocumentSchema>;
export type PatientSubmission = z.infer<typeof PatientSubmissionSchema>;

/** Narrow the nullable collections to plain arrays for rule evaluation. */
export function collections(submission: PatientSubmission): {
  vitals: Vital[];
  labs: LabResult[];
  medications: Medication[];
  conditions: Condition[];
  documents: ClinicalDocument[];
} {
  return {
    vitals: submission.vitals ?? [],
    labs: submission.labs ?? [],
    medications: submission.medications ?? [],
    conditions: submission.conditions ?? [],
    documents: submission.documents ?? [],
  };
}
