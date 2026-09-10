import { makeStlAnalyzeTool } from './stl-analyze.js'
import { makeGenParametricStlTool } from './gen-parametric-stl.js'
import { makeGenCalibrationGcodeTool } from './gen-calibration-gcode.js'
import { makeGcodeEstimateTool } from './gcode-estimate.js'
import { makeGcodeRenderTool } from './gcode-render.js'
import { makeSliceTool } from './slice.js'
import { makeParametricPrintTool } from './parametric-print.js'
import { makeImageToStlTool } from './image-to-stl.js'

export function makeToolDefinitions(ctx) {
  return [
    makeStlAnalyzeTool(ctx),
    makeGenParametricStlTool(ctx),
    makeGenCalibrationGcodeTool(ctx),
    makeGcodeEstimateTool(ctx),
    makeGcodeRenderTool(ctx),
    makeSliceTool(ctx),
    makeParametricPrintTool(ctx),
    makeImageToStlTool(ctx),
  ]
}
