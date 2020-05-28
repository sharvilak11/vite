import chalk from 'chalk'
import path from 'path'
import { ServerPlugin } from '.'
import {
  SFCBlock,
  SFCDescriptor,
  SFCTemplateBlock,
  SFCStyleBlock,
  SFCStyleCompileResults,
  CompilerOptions
} from '@vue/compiler-sfc'
import { resolveCompiler } from '../utils/resolveVue'
import hash_sum from 'hash-sum'
import LRUCache from 'lru-cache'
import {
  debugHmr,
  importerMap,
  ensureMapEntry,
  hmrClientPublicPath
} from './serverPluginHmr'
import { resolveFrom, cachedRead, genSourceMapString, cleanUrl } from '../utils'
import { Context } from 'koa'
import { transform } from '../esbuildService'
import { InternalResolver } from '../resolver'
import { seenUrls } from './serverPluginServeStatic'
import { codegenCss, compileCss, rewriteCssUrls } from '../utils/cssUtils'
import { parse } from '../utils/babelParse'
import MagicString from 'magic-string'
import { resolveImport } from './serverPluginModuleRewrite'

const debug = require('debug')('vite:sfc')
const getEtag = require('etag')

export const srcImportMap = new Map()

interface CacheEntry {
  descriptor?: SFCDescriptor
  template?: string
  script?: string
  styles: SFCStyleCompileResults[]
}

export const vueCache = new LRUCache<string, CacheEntry>({
  max: 65535
})

export const vuePlugin: ServerPlugin = ({
  root,
  app,
  resolver,
  watcher,
  config
}) => {
  const etagCacheCheck = (ctx: Context) => {
    ctx.etag = getEtag(ctx.body)
    // only add 304 tag check if not using service worker to cache user code
    if (!config.serviceWorker) {
      ctx.status =
        seenUrls.has(ctx.url) && ctx.etag === ctx.get('If-None-Match')
          ? 304
          : 200
      seenUrls.add(ctx.url)
    }
  }

  app.use(async (ctx, next) => {
    if (!ctx.path.endsWith('.vue') && !ctx.vue) {
      return next()
    }

    const query = ctx.query
    const publicPath = ctx.path
    let filePath = resolver.requestToFile(publicPath)

    // upstream plugins could've already read the file
    const descriptor = await parseSFC(root, filePath, ctx.body)
    if (!descriptor) {
      debug(`${ctx.url} - 404`)
      ctx.status = 404
      return
    }

    if (!query.type) {
      if (descriptor.script && descriptor.script.src) {
        filePath = await resolveSrcImport(
          root,
          descriptor.script,
          ctx,
          resolver
        )
      }
      ctx.type = 'js'
      ctx.body = await compileSFCMain(descriptor, filePath, publicPath)
      return etagCacheCheck(ctx)
    }

    if (query.type === 'template') {
      const templateBlock = descriptor.template!
      if (templateBlock.src) {
        filePath = await resolveSrcImport(root, templateBlock, ctx, resolver)
      }
      ctx.type = 'js'
      ctx.body = compileSFCTemplate(
        root,
        templateBlock,
        filePath,
        publicPath,
        descriptor.styles.some((s) => s.scoped),
        config.vueCompilerOptions
      )
      return etagCacheCheck(ctx)
    }

    if (query.type === 'style') {
      const index = Number(query.index)
      const styleBlock = descriptor.styles[index]
      if (styleBlock.src) {
        filePath = await resolveSrcImport(root, styleBlock, ctx, resolver)
      }
      const id = hash_sum(publicPath)
      const result = await compileSFCStyle(
        root,
        styleBlock,
        index,
        filePath,
        publicPath
      )
      ctx.type = 'js'
      ctx.body = codegenCss(`${id}-${index}`, result.code, result.modules)
      return etagCacheCheck(ctx)
    }

    // TODO custom blocks
  })

  const handleVueReload = (watcher.handleVueReload = async (
    filePath: string,
    timestamp: number = Date.now(),
    content?: string
  ) => {
    const publicPath = resolver.fileToRequest(filePath)
    const cacheEntry = vueCache.get(filePath)
    const { send } = watcher

    debugHmr(`busting Vue cache for ${filePath}`)
    vueCache.del(filePath)

    const descriptor = await parseSFC(root, filePath, content)
    if (!descriptor) {
      // read failed
      return
    }

    const prevDescriptor = cacheEntry && cacheEntry.descriptor
    if (!prevDescriptor) {
      // the file has never been accessed yet
      debugHmr(`no existing descriptor found for ${filePath}`)
      return
    }

    // check which part of the file changed
    let needRerender = false

    const sendReload = () => {
      send({
        type: 'vue-reload',
        path: publicPath,
        timestamp
      })
      console.log(
        chalk.green(`[vite:hmr] `) +
          `${path.relative(root, filePath)} updated. (reload)`
      )
    }

    if (!isEqualBlock(descriptor.script, prevDescriptor.script)) {
      return sendReload()
    }

    if (!isEqualBlock(descriptor.template, prevDescriptor.template)) {
      needRerender = true
    }

    let didUpdateStyle = false
    const styleId = hash_sum(publicPath)
    const prevStyles = prevDescriptor.styles || []
    const nextStyles = descriptor.styles || []

    // css modules update causes a reload because the $style object is changed
    // and it may be used in JS. It also needs to trigger a vue-style-update
    // event so the client busts the sw cache.
    if (
      prevStyles.some((s) => s.module != null) ||
      nextStyles.some((s) => s.module != null)
    ) {
      return sendReload()
    }

    if (prevStyles.some((s) => s.scoped) !== nextStyles.some((s) => s.scoped)) {
      needRerender = true
    }

    // only need to update styles if not reloading, since reload forces
    // style updates as well.
    nextStyles.forEach((_, i) => {
      if (!prevStyles[i] || !isEqualBlock(prevStyles[i], nextStyles[i])) {
        didUpdateStyle = true
        send({
          type: 'style-update',
          path: `${publicPath}?type=style&index=${i}`,
          timestamp
        })
      }
    })

    // stale styles always need to be removed
    prevStyles.slice(nextStyles.length).forEach((_, i) => {
      didUpdateStyle = true
      send({
        type: 'style-remove',
        path: publicPath,
        id: `${styleId}-${i + nextStyles.length}`,
        timestamp
      })
    })

    if (needRerender) {
      send({
        type: 'vue-rerender',
        path: publicPath,
        timestamp
      })
    }

    let updateType = []
    if (needRerender) {
      updateType.push(`template`)
    }
    if (didUpdateStyle) {
      updateType.push(`style`)
    }
    if (updateType.length) {
      console.log(
        chalk.green(`[vite:hmr] `) +
          `${path.relative(root, filePath)} updated. (${updateType.join(
            ' & '
          )})`
      )
    }
  })

  watcher.on('change', (file) => {
    if (file.endsWith('.vue')) {
      handleVueReload(file)
    }
  })
}

function isEqualBlock(a: SFCBlock | null, b: SFCBlock | null) {
  if (!a && !b) return true
  if (!a || !b) return false
  if (a.content.length !== b.content.length) return false
  if (a.content !== b.content) return false
  const keysA = Object.keys(a.attrs)
  const keysB = Object.keys(b.attrs)
  if (keysA.length !== keysB.length) {
    return false
  }
  return keysA.every((key) => a.attrs[key] === b.attrs[key])
}

async function resolveSrcImport(
  root: string,
  block: SFCBlock,
  ctx: Context,
  resolver: InternalResolver
) {
  const importer = ctx.path
  const importee = cleanUrl(
    resolveImport(process.cwd(), importer, block.src!, resolver)
  )
  const filePath = resolver.requestToFile(importee)
  await cachedRead(ctx, filePath)
  block.content = ctx.body

  // register HMR import relationship
  debugHmr(`        ${importer} imports ${importee}`)
  ensureMapEntry(importerMap, importee).add(ctx.path)
  srcImportMap.set(filePath, ctx.url)
  return filePath
}

export async function parseSFC(
  root: string,
  filePath: string,
  content?: string | Buffer
): Promise<SFCDescriptor | undefined> {
  let cached = vueCache.get(filePath)
  if (cached && cached.descriptor) {
    debug(`${filePath} parse cache hit`)
    return cached.descriptor
  }

  if (!content) {
    try {
      content = await cachedRead(null, filePath)
    } catch (e) {
      return
    }
  }

  if (typeof content !== 'string') {
    content = content.toString()
  }

  const start = Date.now()
  const { parse, generateCodeFrame } = resolveCompiler(root)
  const { descriptor, errors } = parse(content, {
    filename: filePath,
    sourceMap: true
  })

  if (errors.length) {
    console.error(chalk.red(`\n[vite] SFC parse error: `))
    errors.forEach((e) => {
      console.error(
        chalk.underline(
          `${filePath}:${e.loc!.start.line}:${e.loc!.start.column}`
        )
      )
      console.error(chalk.yellow(e.message))
      console.error(
        generateCodeFrame(
          content as string,
          e.loc!.start.offset,
          e.loc!.end.offset
        ) + `\n`
      )
    })
  }

  cached = cached || { styles: [] }
  cached.descriptor = descriptor
  vueCache.set(filePath, cached)
  debug(`${filePath} parsed in ${Date.now() - start}ms.`)
  return descriptor
}

const defaultExportRE = /((?:^|\n|;)\s*)export default/

async function compileSFCMain(
  descriptor: SFCDescriptor,
  filePath: string,
  publicPath: string
): Promise<string> {
  let cached = vueCache.get(filePath)
  if (cached && cached.script) {
    return cached.script
  }

  const id = hash_sum(publicPath)
  let code = ``
  if (descriptor.script) {
    let content = descriptor.script.content
    if (descriptor.script.lang === 'ts') {
      // TODO merge lang=ts source map
      content = (await transform(content, publicPath, { loader: 'ts' })).code
    }
    // rewrite export default.
    // fast path: simple regex replacement to avoid full-blown babel parse.
    let replaced = content.replace(defaultExportRE, '$1const __script =')
    // if the script somehow still contains `default export`, it probably has
    // multi-line comments or template strings. fallback to a full parse.
    if (defaultExportRE.test(replaced)) {
      replaced = rewriteDefaultExport(content)
    }
    code += replaced
  } else {
    code += `const __script = {}`
  }

  let hasScoped = false
  let hasCSSModules = false
  if (descriptor.styles) {
    code += `\nimport { updateStyle } from "${hmrClientPublicPath}"\n`
    descriptor.styles.forEach((s, i) => {
      const styleRequest = publicPath + `?type=style&index=${i}`
      if (s.scoped) hasScoped = true
      if (s.module) {
        if (!hasCSSModules) {
          code += `\nconst __cssModules = __script.__cssModules = {}`
          hasCSSModules = true
        }
        const styleVar = `__style${i}`
        const moduleName = typeof s.module === 'string' ? s.module : '$style'
        code += `\nimport ${styleVar} from ${JSON.stringify(
          styleRequest + '&module'
        )}`
        code += `\n__cssModules[${JSON.stringify(moduleName)}] = ${styleVar}`
      } else {
        code += `\nimport ${JSON.stringify(styleRequest)}`
      }
    })
    if (hasScoped) {
      code += `\n__script.__scopeId = "data-v-${id}"`
    }
  }

  if (descriptor.template) {
    const templateRequest = publicPath + `?type=template`
    code += `\nimport { render as __render } from ${JSON.stringify(
      templateRequest
    )}`
    code += `\n__script.render = __render`
  }
  code += `\n__script.__hmrId = ${JSON.stringify(publicPath)}`
  code += `\n__script.__file = ${JSON.stringify(filePath)}`
  code += `\nexport default __script`

  if (descriptor.script) {
    code += genSourceMapString(descriptor.script.map)
  }

  cached = cached || { styles: [] }
  cached.script = code
  vueCache.set(filePath, cached)
  return code
}

function compileSFCTemplate(
  root: string,
  template: SFCTemplateBlock,
  filePath: string,
  publicPath: string,
  scoped: boolean,
  userOptions: CompilerOptions | undefined
): string {
  let cached = vueCache.get(filePath)
  if (cached && cached.template) {
    debug(`${publicPath} template cache hit`)
    return cached.template
  }

  const start = Date.now()
  const { compileTemplate, generateCodeFrame } = resolveCompiler(root)
  const { code, map, errors } = compileTemplate({
    source: template.content,
    filename: filePath,
    inMap: template.map,
    transformAssetUrls: {
      base: path.posix.dirname(publicPath)
    },
    compilerOptions: {
      ...userOptions,
      scopeId: scoped ? `data-v-${hash_sum(publicPath)}` : null,
      runtimeModuleName: '/@modules/vue'
    },
    preprocessLang: template.lang,
    preprocessCustomRequire: (id: string) => require(resolveFrom(root, id))
  })

  if (errors.length) {
    console.error(chalk.red(`\n[vite] SFC template compilation error: `))
    errors.forEach((e) => {
      if (typeof e === 'string') {
        console.error(e)
      } else {
        console.error(
          chalk.underline(
            `${filePath}:${e.loc!.start.line}:${e.loc!.start.column}`
          )
        )
        console.error(chalk.yellow(e.message))
        const original = template.map!.sourcesContent![0]
        console.error(
          generateCodeFrame(original, e.loc!.start.offset, e.loc!.end.offset) +
            `\n`
        )
      }
    })
  }

  const finalCode = code + genSourceMapString(map)
  cached = cached || { styles: [] }
  cached.template = finalCode
  vueCache.set(filePath, cached)

  debug(`${publicPath} template compiled in ${Date.now() - start}ms.`)
  return finalCode
}

async function compileSFCStyle(
  root: string,
  style: SFCStyleBlock,
  index: number,
  filePath: string,
  publicPath: string
): Promise<SFCStyleCompileResults> {
  let cached = vueCache.get(filePath)
  const cachedEntry = cached && cached.styles && cached.styles[index]
  if (cachedEntry) {
    debug(`${publicPath} style cache hit`)
    return cachedEntry
  }

  const start = Date.now()

  const { generateCodeFrame } = resolveCompiler(root)

  const result = (await compileCss(root, publicPath, {
    source: style.content,
    filename: filePath,
    id: ``, // will be computed in compileCss
    scoped: style.scoped != null,
    modules: style.module != null,
    preprocessLang: style.lang as any
  })) as SFCStyleCompileResults

  if (result.errors.length) {
    console.error(chalk.red(`\n[vite] SFC style compilation error: `))
    result.errors.forEach((e: any) => {
      if (typeof e === 'string') {
        console.error(e)
      } else {
        const lineOffset = style.loc.start.line - 1
        if (e.line && e.column) {
          console.log(
            chalk.underline(`${filePath}:${e.line + lineOffset}:${e.column}`)
          )
        } else {
          console.log(chalk.underline(filePath))
        }
        const filePathRE = new RegExp(
          '.*' +
            path.basename(filePath).replace(/[-[\]/{}()*+?.\\^$|]/g, '\\$&') +
            '(:\\d+:\\d+:\\s*)?'
        )
        const cleanMsg = e.message.replace(filePathRE, '')
        console.error(chalk.yellow(cleanMsg))
        if (e.line && e.column && cleanMsg.split(/\n/g).length === 1) {
          const original = style.map!.sourcesContent![0]
          const offset =
            original
              .split(/\r?\n/g)
              .slice(0, e.line + lineOffset - 1)
              .map((l) => l.length)
              .reduce((total, l) => total + l + 1, 0) +
            e.column -
            1
          console.error(generateCodeFrame(original, offset, offset + 1)) + `\n`
        }
      }
    })
  }

  result.code = await rewriteCssUrls(result.code, publicPath)

  cached = cached || { styles: [] }
  cached.styles[index] = result
  vueCache.set(filePath, cached)

  debug(`${publicPath} style compiled in ${Date.now() - start}ms`)
  return result
}

function rewriteDefaultExport(code: string): string {
  const s = new MagicString(code)
  const ast = parse(code)
  ast.forEach((node) => {
    if (node.type === 'ExportDefaultDeclaration') {
      s.overwrite(node.start!, node.declaration.start!, `const __script = `)
    }
  })
  return s.toString()
}
