/** Rules for the new-session form's "New project" option. Shared so the form can say what's wrong
 *  as you type and the server enforces exactly the same thing. A project folder is a single name,
 *  created directly inside the server's dev root — never a path. */

export const PROJECT_FOLDER_MAX = 100;

/** Why `name` can't be a project folder, or null when it can. */
export function projectFolderProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Give the project folder a name.';
  if (n.length > PROJECT_FOLDER_MAX) return `Keep the folder name under ${PROJECT_FOLDER_MAX} characters.`;
  if (/[\/\\:\0]/.test(n)) return "Folder names can't contain /, \\ or :";
  // A leading "." hides the folder; a leading "~" invites `rm -rf ~`-style accidents in a shell.
  if (/^[.~]/.test(n)) return "Folder names can't start with . or ~";
  return null;
}

/** A starting folder name for a session: "Mustang drift" -> "MustangDrift", the way the dev
 *  folder's projects are already named (StrategicConquest, ProjectOverland). Always editable. */
export function suggestProjectFolder(sessionName: string): string {
  return sessionName
    .replace(/[\/\\:\0]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join('')
    .replace(/^[.~]+/, '');
}
