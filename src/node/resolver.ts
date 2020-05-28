import fs from 'fs'
import path from 'path'
import slash from 'slash'
import { cleanUrl, resolveFrom, queryRE } from './utils'
import {
  idToFileMap,
  moduleRE,
  fileToRequestMap
} from './server/serverPluginModuleResolve'
import { resolveOptimizedCacheDir } from './depOptimizer'
import chalk from 'chalk'

const debug = require('debug')('vite:resolve')

export interface Resolver {
  requestToFile?(publicPath: string, root: string): string | undefined
  fileToRequest?(filePath: string, root: string): string | undefined
  alias?(id: string): string | undefined
}

export interface InternalResolver {
  requestToFile(publicPath: string): string
  fileToRequest(filePath: string): string
  alias(id: string): string | undefined
  resolveExt(publicPath: string): string | undefined
}

export const supportedExts = ['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json']

const defaultRequestToFile = (publicPath: string, root: string): string => {
  if (moduleRE.test(publicPath)) {
    const id = publicPath.replace(moduleRE, '')
    const cachedNodeModule = idToFileMap.get(id)
    if (cachedNodeModule) {
      return cachedNodeModule
    }
    // try to resolve from optimized modules
    const optimizedModule = resolveOptimizedModule(root, id)
    if (optimizedModule) {
      return optimizedModule
    }
    // try to resolve from normal node_modules
    const nodeModule = resolveNodeModuleFile(root, id)
    if (nodeModule) {
      idToFileMap.set(id, nodeModule)
      return nodeModule
    }
  }
  const publicDirPath = path.join(root, 'public', publicPath.slice(1))
  if (fs.existsSync(publicDirPath)) {
    return publicDirPath
  }
  return path.join(root, publicPath.slice(1))
}

const defaultFileToRequest = (filePath: string, root: string): string => {
  const moduleRequest = fileToRequestMap.get(filePath)
  if (moduleRequest) {
    return moduleRequest
  }
  return `/${slash(path.relative(root, filePath))}`
}

const isFile = (file: string): boolean => {
  try {
    return fs.statSync(file).isFile()
  } catch (e) {
    return false
  }
}

const resolveExt = (id: string): string | undefined => {
  const cleanId = cleanUrl(id)
  if (!isFile(cleanId)) {
    let inferredExt = ''
    for (const ext of supportedExts) {
      if (isFile(cleanId + ext)) {
        inferredExt = ext
        break
      }
      if (isFile(path.join(cleanId, '/index' + ext))) {
        inferredExt = '/index' + ext
        break
      }
    }
    const queryMatch = id.match(/\?.*$/)
    const query = queryMatch ? queryMatch[0] : ''
    const resolved = cleanId + inferredExt + query
    if (resolved !== id) {
      debug(`(extension) ${id} -> ${resolved}`)
      return inferredExt
    }
  }
}

export function createResolver(
  root: string,
  resolvers: Resolver[] = [],
  alias: Record<string, string> = {}
): InternalResolver {
  function resolveRequest(
    publicPath: string
  ): {
    filePath: string
    ext: string | undefined
  } {
    let resolved: string | undefined
    for (const r of resolvers) {
      const filepath = r.requestToFile && r.requestToFile(publicPath, root)
      if (filepath) {
        resolved = filepath
        break
      }
    }
    if (!resolved) {
      resolved = defaultRequestToFile(publicPath, root)
    }
    const ext = resolveExt(resolved)
    return {
      filePath: ext ? resolved + ext : resolved,
      ext
    }
  }

  return {
    requestToFile(publicPath) {
      return resolveRequest(publicPath).filePath
    },

    resolveExt(publicPath) {
      return resolveRequest(publicPath).ext
    },

    fileToRequest(filePath) {
      for (const r of resolvers) {
        const request = r.fileToRequest && r.fileToRequest(filePath, root)
        if (request) return request
      }
      return defaultFileToRequest(filePath, root)
    },

    alias(id) {
      let aliased: string | undefined = alias[id]
      if (aliased) {
        return aliased
      }
      for (const r of resolvers) {
        aliased = r.alias && r.alias(id)
        if (aliased) {
          return aliased
        }
      }
    }
  }
}

export const jsSrcRE = /\.(?:(?:j|t)sx?|vue)$|\.mjs$/
const deepImportRE = /^([^@][^/]*)\/|^(@[^/]+\/[^/]+)\//

/**
 * Redirects a bare module request to a full path under /@modules/
 * It resolves a bare node module id to its full entry path so that relative
 * imports from the entry can be correctly resolved.
 * e.g.:
 * - `import 'foo'` -> `import '/@modules/foo/dist/index.js'`
 * - `import 'foo/bar/baz'` -> `import '/@modules/foo/bar/baz'`
 */
export function resolveBareModuleRequest(
  root: string,
  id: string,
  importer: string
): string {
  const optimized = resolveOptimizedModule(root, id)
  if (optimized) {
    return id
  }
  const pkgInfo = resolveNodeModule(root, id)
  if (pkgInfo) {
    if (!pkgInfo.entry) {
      console.error(
        chalk.yellow(
          `[vite] dependency ${id} does not have default entry defined in ` +
            `package.json.`
        )
      )
    }
    return pkgInfo.entry || id
  }

  // check and warn deep imports on optimized modules
  const ext = path.extname(id)
  if (!ext || jsSrcRE.test(ext)) {
    const deepMatch = id.match(deepImportRE)
    if (deepMatch) {
      const depId = deepMatch[1] || deepMatch[2]
      if (resolveOptimizedModule(root, depId)) {
        console.error(
          chalk.yellow(
            `\n[vite] Avoid deep import "${id}" since "${depId}" is a ` +
              `pre-optimized dependency.\n` +
              `Prefer importing from the module directly.\n` +
              `Importer: ${importer}\n`
          )
        )
      }
    }
    return id
  } else {
    // append import query for non-js deep imports
    return id + (queryRE.test(id) ? '&import' : '?import')
  }
}

const viteOptimizedMap = new Map()

export function resolveOptimizedModule(
  root: string,
  id: string
): string | undefined {
  const cached = viteOptimizedMap.get(id)
  if (cached) {
    return cached
  }

  const cacheDir = resolveOptimizedCacheDir(root)
  if (!cacheDir) return
  const file = path.join(cacheDir, id)
  if (fs.existsSync(file)) {
    viteOptimizedMap.set(id, file)
    return file
  }
}

interface NodeModuleInfo {
  entry: string | null
  entryFilePath: string | null
  pkg: any
}
const nodeModulesInfoMap = new Map<string, NodeModuleInfo>()
const nodeModulesFileMap = new Map()

export function resolveNodeModule(
  root: string,
  id: string
): NodeModuleInfo | undefined {
  const cached = nodeModulesInfoMap.get(id)
  if (cached) {
    return cached
  }
  let pkgPath
  try {
    // see if the id is a valid package name
    pkgPath = resolveFrom(root, `${id}/package.json`)
  } catch (e) {}

  if (pkgPath) {
    // if yes, this is a entry import. resolve entry file
    let pkg
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
    } catch (e) {
      return
    }
    let entryPoint: string | undefined
    if (pkg.exports) {
      if (typeof pkg.exports === 'string') {
        entryPoint = pkg.exports
      } else if (pkg.exports['.']) {
        if (typeof pkg.exports['.'] === 'string') {
          entryPoint = pkg.exports['.']
        } else {
          entryPoint = pkg.exports['.'].import
        }
      }
    }
    if (!entryPoint) {
      entryPoint = pkg.module || pkg.main || null
    }

    debug(`(node_module entry) ${id} -> ${entryPoint}`)

    // save resolved entry file path using the deep import path as key
    // e.g. foo/dist/foo.js
    // this is the path raw imports will be rewritten to, and is what will
    // be passed to resolveNodeModuleFile().
    let entryFilePath: string | null = null
    if (entryPoint) {
      // #284 some packages specify entry without extension...
      entryFilePath = path.join(path.dirname(pkgPath), entryPoint!)
      const ext = resolveExt(entryFilePath)
      if (ext) {
        entryPoint += ext
        entryFilePath += ext
      }
      entryPoint = path.posix.join(id, entryPoint!)
      // save the resolved file path now so we don't need to do it again in
      // resolveNodeModuleFile()
      nodeModulesFileMap.set(entryPoint, entryFilePath)
    }

    const result: NodeModuleInfo = {
      entry: entryPoint!,
      entryFilePath,
      pkg
    }
    nodeModulesInfoMap.set(id, result)
    return result
  }
}

export function resolveNodeModuleFile(
  root: string,
  id: string
): string | undefined {
  const cached = nodeModulesFileMap.get(id)
  if (cached) {
    return cached
  }
  try {
    const resolved = resolveFrom(root, id)
    nodeModulesFileMap.set(id, resolved)
    return resolved
  } catch (e) {
    // error will be reported downstream
  }
}
