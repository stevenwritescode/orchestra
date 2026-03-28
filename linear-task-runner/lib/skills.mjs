import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * Read all .md skill files from CLAUDE_SKILLS_DIR and parse their frontmatter.
 * @param {string} skillsDir
 * @param {(msg: string) => void} [log]
 * @returns {{ name: string, description: string, file: string }[]}
 */
export function loadSkills(skillsDir, log = console.log) {
  if (!skillsDir || !existsSync(skillsDir)) return [];
  try {
    return readdirSync(skillsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => {
        const content = readFileSync(join(skillsDir, f), "utf8");
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        const fm = fmMatch ? fmMatch[1] : "";
        const nameMatch = fm.match(/^name:\s*(.+)$/m);
        const descMatch = fm.match(/^description:\s*(.+)$/m);
        const name = nameMatch ? nameMatch[1].trim() : f.replace(/\.md$/, "");
        const description = descMatch ? descMatch[1].trim() : "";
        return { name, description, file: f };
      })
      .filter((s) => s.name);
  } catch (err) {
    log(`Skills: failed to load — ${err.message}`);
    return [];
  }
}

/**
 * Score a skill's relevance to the given keywords string.
 * @param {{ name: string, description: string, file: string }} skill
 * @param {string} keywords - space-separated words to match against
 */
export function scoreSkill(skill, keywords) {
  const haystack = [skill.name, skill.description, skill.file].join(" ").toLowerCase();
  const needles = keywords.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  return needles.filter((w) => haystack.includes(w)).length;
}

/**
 * Build a prompt section listing all available skills with relevant ones first.
 * @param {string} skillsDir
 * @param {string} keywords - text to score relevance against (task title, labels, instructions)
 * @param {(msg: string) => void} [log]
 */
export function buildSkillsPromptSection(skillsDir, keywords, log = console.log) {
  const skills = loadSkills(skillsDir, log);
  if (skills.length === 0) return "";

  const scored = skills
    .map((s) => ({ ...s, score: scoreSkill(s, keywords) }))
    .sort((a, b) => b.score - a.score);

  const relevant = scored.filter((s) => s.score > 0);
  const other = scored.filter((s) => s.score === 0);
  const fmt = (s) => `  /${s.name}${s.description ? ` — ${s.description}` : ""}`;

  const lines = [
    "════════════════════════════════════════════════════════════",
    "AVAILABLE SKILLS",
    "The following Claude Code skills are installed. Invoke relevant ones",
    "early in your session using /<skill-name>.",
    "════════════════════════════════════════════════════════════",
  ];
  if (relevant.length > 0) {
    lines.push("", "LIKELY RELEVANT TO THIS TASK:");
    relevant.forEach((s) => lines.push(fmt(s)));
  }
  if (other.length > 0) {
    lines.push("", "OTHER AVAILABLE SKILLS:");
    other.forEach((s) => lines.push(fmt(s)));
  }
  lines.push("════════════════════════════════════════════════════════════");
  return "\n" + lines.join("\n");
}
