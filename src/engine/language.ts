/**
 * Which language a role should answer the user in.
 *
 * The refiner detects it and every checkpoint records it, but for a long time only three places used it: the
 * chat coach and the two review gates. The tester never heard about it — so a run driven entirely in Turkish
 * answered "Required environment is not running yet. Observed: … Please start: …", and asked its questions in
 * English, for thirty-six minutes. The user finally typed the rule out loud, and even THAT arrived at the
 * agent as English, because the refiner rewrites every request into English before anyone sees it.
 *
 * That rewrite is the reason this exists. The refined prompt is deliberately English — it is the pipeline's
 * working language — so a role reading it has no way to know what the person on the other side actually
 * speaks. It has to be told.
 *
 * Only roles that TALK TO THE USER need it: a tester asking a question and writing a report, the analyst
 * asking about principles, the coach. Code, logs, commit messages and identifiers stay English wherever the
 * project says they do — this is about the reply, not the artefact.
 */
export function respondIn(language?: string): string {
  if (!language || /^english$/i.test(language)) return "";
  return `\n\nRespond to the user in ${language}: everything you say to them, and every question you ask, `
    + `is in ${language}. Code, identifiers, logs and commit messages keep whatever language the project uses.`;
}
