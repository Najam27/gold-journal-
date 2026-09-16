/**
 * Ambient lighting layer.
 *
 * Three soft, accent-toned gradients plus a masked data grid, driven entirely
 * by CSS custom properties (`--tone`, `--tone-2`) that `.gj-shell[data-view]`
 * overrides per destination. Purely decorative: it is fixed, `contain: strict`,
 * never hit-tested and never animated on the main thread.
 */
export function AmbientField() {
  return (
    <div className="gj-ambient" aria-hidden="true">
      <i />
      <i />
      <i />
    </div>
  );
}
