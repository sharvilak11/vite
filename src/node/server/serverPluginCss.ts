import { basename } from 'path'
import { ServerPlugin } from '.'
import hash_sum from 'hash-sum'
import { Context } from 'koa'
import { cleanUrl, isImportRequest, readBody } from '../utils'
import { srcImportMap, vueCache } from './serverPluginVue'
import {
  codegenCss,
  compileCss,
  cssPreprocessLangRE,
  rewriteCssUrls
} from '../utils/cssUtils'
import qs from 'querystring'
import chalk from 'chalk'

interface ProcessedEntry {
  css: string
  modules?: Record<string, string>
}

export const debugCSS = require('debug')('vite:css')

const processedCSS = new Map<string, ProcessedEntry>()

export const cssPlugin: ServerPlugin = ({ root, app, watcher, resolver }) => {
  app.use(async (ctx, next) => {
    await next()
    // handle .css imports
    if (
      (cssPreprocessLangRE.test(ctx.path) || ctx.response.is('css')) &&
      // note ctx.body could be null if upstream set status to 304
      ctx.body
    ) {
      const id = JSON.stringify(hash_sum(ctx.path))
      if (isImportRequest(ctx)) {
        await processCss(root, ctx)
        // we rewrite css with `?import` to a js module that inserts a style
        // tag linking to the actual raw url
        ctx.type = 'js'
        const { css, modules } = processedCSS.get(ctx.path)!
        ctx.body = codegenCss(id, css, modules)
      } else {
        // raw request, return compiled css
        if (!processedCSS.has(ctx.path)) {
          await processCss(root, ctx)
        }
        ctx.type = 'css'
        ctx.body = processedCSS.get(ctx.path)!.css
      }
    }
  })

  watcher.on('change', (filePath) => {
    if (filePath.endsWith('.css') || cssPreprocessLangRE.test(filePath)) {
      const publicPath = resolver.fileToRequest(filePath)

      /** filter unused files */
      if (!processedCSS.has(publicPath) && !srcImportMap.has(filePath)) {
        return debugCSS(
          `${basename(publicPath)} has changed, but it is not currently in use`
        )
      }

      if (srcImportMap.has(filePath)) {
        // handle HMR for <style src="xxx.css">
        // it cannot be handled as simple css import because it may be scoped
        const styleImport = srcImportMap.get(filePath)
        vueCache.del(filePath)
        const publicPath = cleanUrl(styleImport)
        const index = qs.parse(styleImport.split('?', 2)[1]).index
        console.log(
          chalk.green(`[vite:hmr] `) + `${publicPath} updated. (style)`
        )
        watcher.send({
          type: 'style-update',
          path: `${publicPath}?type=style&index=${index}`,
          timestamp: Date.now()
        })
        return
      }
      // handle HMR for module.css
      // it cannot process with normal css, the class which in module.css maybe removed
      if (filePath.endsWith('.module.css')) {
        watcher.handleJSReload(filePath, Date.now())
        return
      }

      // bust process cache
      processedCSS.delete(publicPath)

      watcher.send({
        type: 'style-update',
        path: publicPath,
        timestamp: Date.now()
      })
    }
  })

  async function processCss(root: string, ctx: Context) {
    let css = (await readBody(ctx.body))!

    const result = await compileCss(root, ctx.path, {
      id: '',
      source: css,
      filename: resolver.requestToFile(ctx.path),
      scoped: false,
      modules: ctx.path.endsWith('.module.css'),
      preprocessLang: ctx.path.replace(cssPreprocessLangRE, '$2') as any
    })

    if (typeof result === 'string') {
      processedCSS.set(ctx.path, { css })
      return
    }

    if (result.errors.length) {
      console.error(`[vite] error applying css transforms: `)
      result.errors.forEach(console.error)
    }

    result.code = await rewriteCssUrls(result.code, ctx.path)

    processedCSS.set(ctx.path, {
      css: result.code,
      modules: result.modules
    })
  }
}
