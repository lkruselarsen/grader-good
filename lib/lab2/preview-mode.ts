/**
 * Lab2 preview mode: which renderer draws the preview and whether the
 * finishing effects (highlight warmth + halation) are on. Shared by the lab2
 * page and the bulk editor so both follow the same rules. Slider values are
 * never part of this state, so toggling never loses them.
 */

export type PreviewRenderer = "2d" | "webgl";

export type PreviewModeState = {
  previewRenderer: PreviewRenderer;
  effectsEnabled: boolean;
};

export type PreviewModeAction =
  | { type: "setEffectsEnabled"; value: boolean }
  | { type: "setRenderer"; value: PreviewRenderer }
  | { type: "replace"; value: PreviewModeState };

export const DEFAULT_PREVIEW_MODE: PreviewModeState = {
  previewRenderer: "2d",
  effectsEnabled: false,
};

export function previewModeReducer(
  state: PreviewModeState,
  action: PreviewModeAction
): PreviewModeState {
  switch (action.type) {
    case "setEffectsEnabled":
      // Effects need the WebGL presenter; turning them off returns to today's 2D path.
      return action.value
        ? { previewRenderer: "webgl", effectsEnabled: true }
        : { previewRenderer: "2d", effectsEnabled: false };
    case "setRenderer":
      // 2D never shows effects; WebGL with effects off is a passthrough.
      return action.value === "2d"
        ? { previewRenderer: "2d", effectsEnabled: false }
        : { previewRenderer: "webgl", effectsEnabled: state.effectsEnabled };
    case "replace":
      // Restoring saved state: effects can only be on in WebGL mode.
      return action.value.previewRenderer === "webgl"
        ? { previewRenderer: "webgl", effectsEnabled: !!action.value.effectsEnabled }
        : { previewRenderer: "2d", effectsEnabled: false };
    default:
      return state;
  }
}
