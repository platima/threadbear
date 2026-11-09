// What the model menu's tooltip says (Controls.tsx): the models can't be listed because
// the runner is not connected, because it has found no login for this, or because it
// hasn't learned this login's models yet (the list comes from the program itself, after
// it has run once); and the ordinary one when there is something to choose. Not a
// Claude-only instruction: the login may be another provider's.
export function modelMenuTip(o: { offline?: boolean; models: number; hasAccount: boolean }): string {
  if (o.offline) return "Not connected to the runner, so the models can't be listed";
  if (o.models) return 'Choose the model';
  if (o.hasAccount) return "This login's models haven't been listed yet, so there is nothing to choose. It runs on the login's default.";
  return "The runner hasn't found a login for this yet, so there is no model list. See Settings, Logins and pools.";
}
