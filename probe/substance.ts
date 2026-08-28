/**
 * Is the page a human would accept, or only a page the postcondition accepts?
 *
 * Every other check in this probe asks whether a structure EXISTS: a page with
 * this title, in this section, carrying this string. None of them ask whether
 * what was written is worth reading. An agent that splits a page into two
 * headings with a sentence under each satisfies `allPagesExist` completely, and
 * a reader would call the result broken.
 *
 * That hole is the fair half of the obvious objection to this benchmark — that
 * it scores technically-correct output nobody would ship. This closes it in the
 * cheapest honest way: count the words of real prose on pages the instruction
 * asked the agent to WRITE, and hold them to a floor.
 *
 * Deliberately conservative, for the same reason the drift race's assertions
 * are: the floor asserts only what the instruction plainly implies. C1 says
 * "one short paragraph is enough", so its floor is one short paragraph. R3
 * divides a page that already held real content, so each half must hold some.
 * Demanding more would encode this author's taste as ground truth and score a
 * house style rather than a capability.
 *
 * Markup and reference syntax are stripped before counting, so a substrate
 * whose body format is verbose is not credited for its own boilerplate.
 */

/** Body text with markup, CMS reference syntax and JSON keys removed. */
export function plainWords(body: string): number {
  if (!body) return 0
  const text = body
    // Reference syntax needs UNPICKING, not deleting. A design system carries
    // real prose inside component parameters — `body_html=<p>v1 returned bare
    // error strings…</p>` is the page's actual content — so stripping {{…}}
    // wholesale erased it and scored a rich page as a four-word stub. That
    // penalised one substrate for where its content model puts the words, which
    // is precisely the bias this probe exists to avoid.
    .replace(/\{\{cms:item\/[0-9a-f-]+\|?([^}]*)\}\}/gi, ' $1 ')   // keep any link text
    .replace(/\{\{ds:token\/[^}]*\}\}/gi, ' ')                     // a token is a value, not prose
    .replace(/\{\{ds:component\/[a-z0-9_-]+\|?/gi, ' ')             // drop the component name…
    .replace(/\}\}/g, ' ')                                          // …and its closing brace
    .replace(/(^|[\s|])[a-z_]+=/gi, ' ')                             // drop `param=` names, keep values
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')                  // HTML tags
    .replace(/"_(type|key|ref|id|rev)"\s*:\s*"[^"]*"/g, ' ')  // JSON structural keys
    .replace(/"(_type|_key|_ref|style|marks|markDefs|children|blockType|size)"\s*:/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[{}\[\]",:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // A "word" needs a letter in it, so ids and punctuation do not inflate the count.
  return text.split(' ').filter(w => /[a-z]/i.test(w) && w.length > 1).length
}

export interface SubstanceResult { ok: boolean; detail: string }

/**
 * @param pages  title -> body, for every page the instruction asked to be written
 * @param min    word floor, from the intent
 */
export function checkSubstance(
  pages: Array<{ title: string; body: string | null }>,
  min: number,
): SubstanceResult {
  const counts = pages.map(p => ({ title: p.title, words: p.body === null ? -1 : plainWords(p.body) }))
  const missing = counts.filter(c => c.words < 0).map(c => c.title)
  if (missing.length) return { ok: false, detail: `no page titled ${missing.join(', ')}` }
  const thin = counts.filter(c => c.words < min)
  const summary = counts.map(c => `${c.title} ${c.words}w`).join(', ')
  return thin.length
    ? { ok: false, detail: `thin: ${summary} (floor ${min})` }
    : { ok: true, detail: `${summary} (floor ${min})` }
}
