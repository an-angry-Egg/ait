import { parse as parseTemplate } from '@vue/compiler-dom'
import { parse as parseSFC } from '@vue/compiler-sfc'
import { relative } from 'node:path'

/**
 * 编译期把「元素 → 源码位置」写进 DOM 属性，取值为 相对路径:行:列。
 *
 * 为什么不在运行时推断：生产构建后组件名被压缩成 Gs / pz，React 19 又收紧了
 * Fiber 访问权限。推断出来的位置不可用，只有编译期记录的位置才是准的。
 *
 * 为什么只注入原生标签：给 <MyCard> 注入属性会变成 props 透传，可能触发
 * Vue 的未知属性警告；而用户真正能指的地方几乎都是原生元素。
 */

const BUILTIN_COMPONENTS = new Set([
  'template',
  'slot',
  'component',
  'transition',
  'transition-group',
  'keep-alive',
  'teleport',
  'suspense'
])

function isNativeTag(tag) {
  return /^[a-z][a-z0-9-]*$/.test(tag) && !BUILTIN_COMPONENTS.has(tag)
}

/** 由字节偏移换算成 1-based 的行列 */
function lineColOf(source, offset) {
  let line = 1
  let lastBreak = -1
  for (let i = 0; i < offset; i++) {
    if (source.charCodeAt(i) === 10) {
      line++
      lastBreak = i
    }
  }
  return { line, column: offset - lastBreak }
}

/** 递归所有含 children / branches 的节点，回调元素节点 */
function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit)
    return
  }
  if (node.type === 1) visit(node)
  if (node.children) walk(node.children, visit)
  if (node.branches) walk(node.branches, visit)
  if (node.elseBranch) walk(node.elseBranch, visit)
}

export default function aitPlugin(options = {}) {
  const attrName = options.attr ?? 'data-ait'
  let root = process.cwd()

  return {
    name: 'ait:data-source',
    apply: 'serve',
    enforce: 'pre',

    configResolved(config) {
      root = config.root || root
    },

    transform(code, id) {
      if (id.startsWith('\0')) return null
      const cleanId = id.split('?')[0]
      if (!cleanId.endsWith('.vue')) return null
      if (id.includes('?')) return null

      let descriptor
      try {
        const parsed = parseSFC(code, { filename: cleanId })
        descriptor = parsed.descriptor
      } catch {
        return null
      }
      if (!descriptor.template) return null

      // descriptor.template.loc.start.offset 已经是模板内容的起点（'<template>' 之后），
      // 不能再额外去找第一个 '>'，否则偏移会整体错位。
      const contentStart = descriptor.template.loc.start.offset
      const content = descriptor.template.content
      const contentPos = lineColOf(code, contentStart)

      let ast
      try {
        ast = parseTemplate(content, { comments: false })
      } catch {
        return null
      }

      const rel = relative(root, cleanId).replaceAll('\\', '/')
      const edits = []

      walk(ast, (node) => {
        if (!isNativeTag(node.tag)) return
        if ((node.props || []).some((p) => p.type === 6 && p.name === attrName)) return

        const offsetInContent = node.loc.start.offset
        // node.loc.start.offset 指向 '<'，向后跳过标签名
        let cursor = offsetInContent + 1
        while (cursor < content.length && !/[\s/>]/.test(content[cursor])) cursor++
        if (cursor >= content.length) return

        const line =
          node.loc.start.line === 1
            ? contentPos.line
            : contentPos.line + node.loc.start.line - 1
        const column =
          node.loc.start.line === 1
            ? contentPos.column + node.loc.start.column - 1
            : node.loc.start.column

        edits.push({
          at: contentStart + cursor,
          text: ` ${attrName}="${rel}:${line}:${column}"`
        })
      })

      if (!edits.length) return null

      edits.sort((a, b) => b.at - a.at)
      let output = code
      for (const edit of edits) {
        output = output.slice(0, edit.at) + edit.text + output.slice(edit.at)
      }

      return { code: output, map: null }
    }
  }
}
