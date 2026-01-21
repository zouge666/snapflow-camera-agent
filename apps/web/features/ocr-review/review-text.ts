export const MAX_TRANSCRIPT_LENGTH = 12_000;

export type ReviewTextFields = Readonly<{
  transcript: string;
  locale: string;
  timezone: string;
  referenceDate: string;
}>;

export type ReviewTextErrors = Partial<
  Record<keyof ReviewTextFields | "confirmation", string>
>;

export type ReviewTextState = Readonly<{
  initialFields: ReviewTextFields;
  fields: ReviewTextFields;
  confirmationChecked: boolean;
  errors: ReviewTextErrors;
  status: "editing" | "confirmed";
}>;

export type ReviewTextAction =
  | Readonly<{
      type: "change-field";
      field: keyof ReviewTextFields;
      value: string;
    }>
  | Readonly<{ type: "toggle-confirmation"; checked: boolean }>
  | Readonly<{ type: "reset" }>
  | Readonly<{ type: "submit" }>;

function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (!match) {
    return false;
  }

  const [, year, month, day] = match;
  const date = new Date(`${value}T00:00:00Z`);

  return (
    !Number.isNaN(date.getTime()) &&
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() + 1 === Number(month) &&
    date.getUTCDate() === Number(day)
  );
}

export function validateReviewText(fields: ReviewTextFields): ReviewTextErrors {
  const errors: ReviewTextErrors = {};

  if (fields.transcript.trim().length === 0) {
    errors.transcript = "Add some meeting text before you confirm it.";
  } else if (fields.transcript.length > MAX_TRANSCRIPT_LENGTH) {
    errors.transcript = `Keep the transcript at ${MAX_TRANSCRIPT_LENGTH.toLocaleString("en-US")} characters or fewer.`;
  }

  if (fields.locale.trim().length === 0) {
    errors.locale = "Add a locale so dates and language can be interpreted correctly.";
  }

  if (fields.timezone.trim().length === 0) {
    errors.timezone = "Add a timezone so relative dates have the right context.";
  }

  if (!isValidIsoDate(fields.referenceDate)) {
    errors.referenceDate = "Use a valid reference date in YYYY-MM-DD format.";
  }

  return errors;
}

export function createReviewTextState(fields: ReviewTextFields): ReviewTextState {
  return {
    initialFields: fields,
    fields,
    confirmationChecked: false,
    errors: {},
    status: "editing",
  };
}

export function reviewTextReducer(
  state: ReviewTextState,
  action: ReviewTextAction,
): ReviewTextState {
  switch (action.type) {
    case "change-field": {
      const errors = { ...state.errors };
      delete errors[action.field];
      delete errors.confirmation;

      return {
        ...state,
        fields: { ...state.fields, [action.field]: action.value },
        confirmationChecked: false,
        errors,
        status: "editing",
      };
    }
    case "toggle-confirmation": {
      const errors = { ...state.errors };
      delete errors.confirmation;

      return {
        ...state,
        confirmationChecked: action.checked,
        errors,
        status: "editing",
      };
    }
    case "reset":
      return createReviewTextState(state.initialFields);
    case "submit": {
      const errors = validateReviewText(state.fields);

      if (!state.confirmationChecked) {
        errors.confirmation = "Review the text and check this box before continuing.";
      }

      return {
        ...state,
        errors,
        status: Object.keys(errors).length === 0 ? "confirmed" : "editing",
      };
    }
  }
}
