import manifest from "../../public/samples/northstar-planning/manifest.json";

export type ReviewSample = Readonly<{
  id: string;
  title: string;
  summary: string;
  languageLabel: string;
  image: Readonly<{
    src: string;
    width: number;
    height: number;
    alt: string;
  }>;
  transcript: string;
  locale: string;
  timezone: string;
  referenceDate: string;
}>;

export const northstarPlanningSample: ReviewSample = {
  id: manifest.id,
  title: "Northstar planning board",
  summary:
    "Three fictional follow-ups with a relative date, a missing owner, and an ambiguous deadline.",
  languageLabel: "English",
  image: {
    src: manifest.artifacts.image.public_path,
    width: manifest.artifacts.image.width,
    height: manifest.artifacts.image.height,
    alt: manifest.artifacts.image.alt_text,
  },
  transcript: manifest.input.text,
  locale: manifest.input.locale,
  timezone: manifest.input.timezone,
  referenceDate: manifest.input.reference_date,
};
