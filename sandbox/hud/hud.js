// Live mod for the main HUD (see sandbox\README.md): mount() runs on every save, after the previous
// version has been taken down. Put visible additions into hud.layer and return a cleanup function.
export function mount(hud) {
  return () => {};
}
