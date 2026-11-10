export type Tone = "neutral" | "sky" | "olive" | "sand" | "danger";

export function scoreTone(score: number | null | undefined, passed?: boolean): Tone {
  if (score == null) return "neutral";
  if (passed === false) return "danger";
  return score >= 75 ? "olive" : score >= 55 ? "sand" : "danger";
}
