// Shared template substitution for the scaffolders. Replaces `{{var}}` placeholders
// from `vars`, throwing on an unknown placeholder rather than leaking a literal
// `{{var}}` into generated output — a template typo is a bug, not output. Zero
// dependencies (pure string work).
export function renderTemplate(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`template var not provided: ${k}`);
    return vars[k];
  });
}
