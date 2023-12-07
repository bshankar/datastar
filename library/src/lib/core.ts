import { toHTMLorSVGElement } from './dom'
import { DeepSignal, DeepState, deepSignal } from './external/deepsignal'
import { Signal, computed, effect, signal } from './external/preact-core'
import { apply } from './external/ts-merge-patch'
import { CorePlugins, CorePreprocessors } from './plugins/core'
import {
  Actions,
  AttributeContext,
  AttributePlugin,
  ExpressionFunction,
  HTMLorSVGElement,
  OnRemovalFn,
  Preprocesser,
  Reactivity,
} from './types'

export class Datastar {
  plugins: AttributePlugin[] = []
  store: DeepSignal<any> = deepSignal({})
  actions: Actions = {}
  refs: Record<string, HTMLElement> = {}
  reactivity: Reactivity = {
    signal,
    computed,
    effect,
  }
  parentID = ''
  missingIDNext = 0
  removals = new Map<Element, Set<OnRemovalFn>>()

  constructor(actions: Actions = {}, ...plugins: AttributePlugin[]) {
    this.actions = Object.assign(this.actions, actions)
    plugins = [...CorePlugins, ...plugins]
    if (!plugins.length) throw new Error('No plugins provided')

    const allPluginPrefixes = new Set<string>()
    for (const p of plugins) {
      if (p.requiredPluginPrefixes) {
        for (const requiredPluginType of p.requiredPluginPrefixes) {
          if (!allPluginPrefixes.has(requiredPluginType)) {
            throw new Error(`Plugin ${p.prefix} requires plugin ${requiredPluginType}`)
          }
        }
      }

      this.plugins.push(p)
      allPluginPrefixes.add(p.prefix)
    }
  }

  run() {
    this.plugins.forEach((p) => {
      if (p.onGlobalInit) {
        p.onGlobalInit({
          actions: this.actions,
          refs: this.refs,
          reactivity: this.reactivity,
          mergeStore: this.mergeStore.bind(this),
          store: this.store,
        })
      }
    })
    this.applyPlugins(document.body)
  }

  private cleanupElementRemovals(element: Element) {
    const removalSet = this.removals.get(element)
    if (removalSet) {
      for (const removal of removalSet) {
        removal()
      }
      this.removals.delete(element)
    }
  }

  private mergeStore(store: DeepState) {
    const revisedStore = apply(this.store.value, store) as DeepState
    this.store = deepSignal(revisedStore)
  }

  public signalByName<T>(name: string) {
    return (this.store as any)[name] as Signal<T>
  }

  private applyPlugins(rootElement: Element) {
    const appliedProcessors = new Set<Preprocesser>()

    this.plugins.forEach((p, pi) => {
      this.walkDownDOM(rootElement, (el) => {
        if (pi === 0) this.cleanupElementRemovals(el)

        for (const dsKey in el.dataset) {
          let expression = el.dataset[dsKey] || ''

          if (!dsKey.startsWith(p.prefix)) continue

          if (el.id.length === 0) {
            el.id = `ds-${this.parentID}-${this.missingIDNext++}`
          }

          appliedProcessors.clear()

          if (p.allowedTagRegexps) {
            const lowerCaseTag = el.tagName.toLowerCase()
            const allowed = [...p.allowedTagRegexps].some((r) => lowerCaseTag.match(r))
            if (!allowed) {
              throw new Error(
                `Tag '${el.tagName}' is not allowed for plugin '${dsKey}', allowed tags are: ${[
                  [...p.allowedTagRegexps].map((t) => `'${t}'`),
                ].join(', ')}`,
              )
            }
            // console.log(`Tag '${el.tagName}' is allowed for plugin '${dsKey}'`)
          }

          let keyRaw = dsKey.slice(p.prefix.length)
          let [key, ...modifiersWithArgsArr] = keyRaw.split('.')
          if (p.mustHaveEmptyKey && key.length > 0) {
            throw new Error(`Attribute '${dsKey}' must have empty key`)
          }
          if (p.mustNotEmptyKey && key.length === 0) {
            throw new Error(`Attribute '${dsKey}' must have non-empty key`)
          }
          if (key.length) {
            key = key[0].toLowerCase() + key.slice(1)
          }

          const modifiersArr = modifiersWithArgsArr.map((m) => {
            const [label, ...args] = m.split('_')
            return { label, args }
          })
          if (p.allowedModifiers) {
            for (const modifier of modifiersArr) {
              if (!p.allowedModifiers.has(modifier.label)) {
                throw new Error(`Modifier '${modifier.label}' is not allowed`)
              }
            }
          }
          const modifiers = new Map<string, string[]>()
          for (const modifier of modifiersArr) {
            modifiers.set(modifier.label, modifier.args)
          }

          if (p.mustHaveEmptyExpression && expression.length) {
            throw new Error(`Attribute '${dsKey}' must have empty expression`)
          }
          if (p.mustNotEmptyExpression && !expression.length) {
            throw new Error(`Attribute '${dsKey}' must have non-empty expression`)
          }

          const processors = [...CorePreprocessors, ...(p.preprocessors || [])]
          for (const processor of processors) {
            if (appliedProcessors.has(processor)) continue
            appliedProcessors.add(processor)
            const matches = [...expression.matchAll(processor.regexp)]
            if (matches.length) {
              for (const match of matches) {
                if (!match.groups) continue
                const { groups } = match
                const { whole } = groups
                expression = expression.replace(whole, processor.replacer(groups))
              }
            }
          }

          const { store, reactivity, actions, refs } = this
          const ctx: AttributeContext = {
            store,
            mergeStore: this.mergeStore.bind(this),
            applyPlugins: this.applyPlugins.bind(this),
            cleanupElementRemovals: this.cleanupElementRemovals.bind(this),
            actions,
            refs,
            reactivity,
            el,
            key,
            expression,
            expressionFn: () => {
              throw new Error('Expression function not created')
            },
            modifiers,
          }

          if (!p.bypassExpressionFunctionCreation?.(ctx) && !p.mustHaveEmptyExpression && expression.length) {
            const lines = expression.split(';')
            lines[lines.length - 1] = `return ${lines[lines.length - 1]}`
            const fnContent = lines.join(';')
            try {
              const fn = new Function('ctx', fnContent) as ExpressionFunction
              ctx.expressionFn = fn
            } catch (e) {
              console.error(e)
              console.error(`Error evaluating expression '${fnContent}' on ${el.id ? `#${el.id}` : el.tagName}`)
              return
            }
          }

          const removal = p.onLoad(ctx)
          if (removal) {
            if (!this.removals.has(el)) {
              this.removals.set(el, new Set())
            }
            this.removals.get(el)!.add(removal)
          }
        }
      })
    })
  }

  private walkDownDOM(element: Element | null, callback: (el: HTMLorSVGElement) => void, siblingOffset = 0) {
    if (!element) return
    const el = toHTMLorSVGElement(element)
    if (!el) return

    callback(el)

    siblingOffset = 0
    element = element.firstElementChild
    while (element) {
      this.walkDownDOM(element, callback, siblingOffset++)
      element = element.nextElementSibling
    }
  }
}
