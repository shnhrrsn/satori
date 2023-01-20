/**
 * This module calculates the layout of a text string. Currently the only
 * supported inline node is text. All other nodes are using block layout.
 */
import type { LayoutContext } from './layout'

import getYoga from './yoga'
import { v, segment, wordSeparators, buildXMLString } from './utils'
import text, { container } from './builder/text'
import { dropShadow } from './builder/shadow'
import decoration from './builder/text-decoration'
import { Locale } from './language'

export interface InlineTextStyle {
  color: string
}

export class InlineText {
  constructor(
    public readonly content: string,
    public readonly style?: Partial<InlineTextStyle>
  ) {}
}

export default async function* buildTextNodes(
  contents: InlineText[],
  context: LayoutContext
): AsyncGenerator<{ word: string; locale?: Locale }[], string, [any, any]> {
  const Yoga = getYoga()

  const {
    parentStyle,
    inheritedStyle,
    parent,
    font,
    id,
    isInheritingTransform,
    debug,
    embedFont,
    graphemeImages,
    locale,
    canLoadAdditionalAssets,
  } = context

  if (parentStyle.textTransform === 'uppercase') {
    contents = contents.map(
      (c) => new InlineText(c.content.toLocaleUpperCase(locale), c.style)
    )
  } else if (parentStyle.textTransform === 'lowercase') {
    contents = contents.map(
      (c) => new InlineText(c.content.toLocaleLowerCase(locale), c.style)
    )
  } else if (parentStyle.textTransform === 'capitalize') {
    contents = contents.map(
      (c) =>
        new InlineText(
          segment(c.content, 'word', locale)
            // For each word...
            .map((word) => {
              // ...split into graphemes...
              return segment(word, 'grapheme', locale)
                .map((grapheme, index) => {
                  // ...and make the first grapheme uppercase
                  return index === 0
                    ? grapheme.toLocaleUpperCase(locale)
                    : grapheme
                })
                .join('')
            })
            .join(''),
          c.style
        )
    )
  }

  const isBreakWord = parentStyle.wordBreak === 'break-word'
  const segmenter = v(
    parentStyle.wordBreak,
    {
      normal: 'word',
      'break-all': 'grapheme',
      'break-word': 'word',
      'keep-all': 'word',
    },
    'word',
    'wordBreak'
  )

  const words = contents
    .map((c) =>
      segment(c.content, segmenter, locale).map(
        (word) => new InlineText(word, c.style)
      )
    )
    .flat()

  // Create a container node for this text fragment.
  const textContainer = Yoga.Node.create()
  textContainer.setAlignItems(Yoga.ALIGN_BASELINE)
  textContainer.setJustifyContent(
    v(
      parentStyle.textAlign,
      {
        left: Yoga.JUSTIFY_FLEX_START,
        right: Yoga.JUSTIFY_FLEX_END,
        center: Yoga.JUSTIFY_CENTER,
        justify: Yoga.JUSTIFY_SPACE_BETWEEN,
        // We don't have other writing modes yet.
        start: Yoga.JUSTIFY_FLEX_START,
        end: Yoga.JUSTIFY_FLEX_END,
      },
      Yoga.JUSTIFY_FLEX_START,
      'textAlign'
    )
  )
  parent.insertChild(textContainer, parent.getChildCount())

  const {
    textAlign,
    textOverflow,
    whiteSpace,
    lineHeight,
    filter: cssFilter,
    _inheritedBackgroundClipTextPath,
  } = parentStyle

  const baseFontSize = parentStyle.fontSize as number

  // Get the correct font according to the container style.
  // https://www.w3.org/TR/CSS2/visudet.html
  let engine = font.getEngine(
    baseFontSize,
    lineHeight as number,
    parentStyle as any,
    locale
  )

  // Yield segments that are missing a font.
  const wordsMissingFont = canLoadAdditionalAssets
    ? words.filter((word) => !engine.has(word.content))
    : []

  yield wordsMissingFont.map((word) => {
    return {
      word: word.content,
      locale,
    }
  })

  if (wordsMissingFont.length) {
    // Reload the engine with additional fonts.
    engine = font.getEngine(
      baseFontSize,
      lineHeight as number,
      parentStyle as any,
      locale
    )
  }

  // Compute the layout.
  // @TODO: Use segments instead of words to properly support kerning.
  let lineWidths: number[] = []
  let baselines: number[] = []
  let lineSegmentNumber: number[] = []
  let wordPositionInLayout: (null | {
    x: number
    y: number
    width: number
    line: number
    lineIndex: number
  })[] = []

  // We can cache the measured width of each word as the measure function will be
  // called multiple times.
  const wordWidthCache = new Map<string, number>()
  const measureWithCache = (segments: string[]) => {
    let total = 0
    for (const s of segments) {
      if (wordWidthCache.has(s)) {
        total += wordWidthCache.get(s)
        continue
      }
      const width = engine.measure(s, parentStyle as any)
      wordWidthCache.set(s, width)
      total += width
    }
    return total
  }

  // Calculate the minimal possible width of the parent container so it don't
  // shrink below the content.
  let minWidth = 0
  let remainingSegment: string[] = []
  let extraWidth = 0
  for (const word of words) {
    let breakSegment = false
    const isImage = graphemeImages && graphemeImages[word.content]

    if (whiteSpace === 'pre') {
      // For `pre`, only break the line for `\n`.
      breakSegment = word[0].content === '\n'
    } else if (whiteSpace !== 'nowrap') {
      // For `normal`, `pre-wrap`, `pre-line` we can wrap with any word separators or
      // images.
      if (isImage || wordSeparators.includes(word.content[0])) {
        breakSegment = true
      }
    }

    if (!breakSegment) {
      if (
        !wordSeparators.includes(word.content[0]) ||
        !remainingSegment.length
      ) {
        remainingSegment.push(word.content === '\n' ? ' ' : word.content)
      }
    } else {
      if (whiteSpace === 'nowrap') {
        extraWidth +=
          measureWithCache(remainingSegment) + (parentStyle.fontSize as number)
      } else {
        minWidth = Math.max(minWidth, measureWithCache(remainingSegment))
        if (isImage) {
          minWidth = Math.max(minWidth, parentStyle.fontSize as number)
        }
      }
      remainingSegment = []
    }
  }
  minWidth = Math.max(minWidth, measureWithCache(remainingSegment) + extraWidth)
  const currentMinWidth = parent.getMinWidth()
  const currentMaxWidth = parent.getMaxWidth()
  const currentWidth = parent.getWidth()
  if (
    isNaN(currentWidth.value) &&
    (isNaN(currentMinWidth.value) ||
      (currentMinWidth.unit === 1 && currentMinWidth.value > minWidth))
  ) {
    // minWidth cannot be larger than maxWidth
    if (!isNaN(currentMaxWidth.value)) {
      if (currentMaxWidth.unit === 1) {
        minWidth = Math.min(minWidth, currentMaxWidth.value)
      } else {
        // @TODO: Support percentage units.
      }
    }
    parent.setMinWidth(minWidth)
  }
  if (typeof parentStyle.flexShrink === 'undefined') {
    parent.setFlexShrink(1)
  }

  const shouldKeepLinebreak = ['pre', 'pre-wrap', 'pre-line'].includes(
    whiteSpace as string
  )
  const shouldCollapseWhitespace = !['pre', 'pre-wrap'].includes(
    whiteSpace as string
  )

  textContainer.setMeasureFunc((width) => {
    let lines = 0
    let remainingSpace = ''
    let remainingSpaceWidth = 0
    let _currentWidth = 0
    let maxWidth = 0
    let lineIndex = -1
    let height = 0
    let currentLineHeight = 0
    let currentBaselineOffset = 0

    lineWidths = []
    lineSegmentNumber = [0]

    // We naively implement the width calculation without proper kerning.
    // @TODO: Support different writing modes.
    // @TODO: Support RTL languages.
    for (let i = 0; i < words.length; i++) {
      const word = words[i]

      const forceBreak = shouldKeepLinebreak && word.content === '\n'

      // A character is a word separator if `white-space` is not `pre`.
      if (
        shouldCollapseWhitespace &&
        wordSeparators.includes(
          // It's possible that the segment contains multiple separate words such
          // as `  `. We can just use the first character to detect.
          word[0]
        ) &&
        !forceBreak
      ) {
        // Multiple whitespaces are considered as one.
        if (!remainingSpace) {
          remainingSpace = ' '
        }
        remainingSpaceWidth = measureWithCache([remainingSpace])
        wordPositionInLayout[i] = null
      } else {
        const w = forceBreak
          ? 0
          : graphemeImages && graphemeImages[word.content]
          ? (parentStyle.fontSize as number)
          : measureWithCache([word.content])

        // When starting a new line from an empty line, we should push one extra
        // line height.
        if (forceBreak && currentLineHeight === 0) {
          currentLineHeight = engine.height(word.content)
        }

        // This is the start of the line, we can ignore all spaces here.
        if (!_currentWidth) {
          remainingSpace = ''
          remainingSpaceWidth = 0
        }

        const allowedToPutAtBeginning =
          remainingSpaceWidth || ',.!?:-@)>]}%#'.indexOf(word[0]) < 0
        const allowedToJustify = !_currentWidth || !!remainingSpaceWidth

        const willWrap =
          i &&
          allowedToPutAtBeginning &&
          _currentWidth + remainingSpaceWidth + w > width &&
          whiteSpace !== 'nowrap' &&
          whiteSpace !== 'pre'

        // Need to break the word if:
        // - we have break-word
        // - the word is wider than the container width
        // - the word will be put at the beginning of the line
        const needToBreakWord =
          isBreakWord && w > width && (!_currentWidth || willWrap || forceBreak)

        if (needToBreakWord) {
          // Break the word into multiple segments and continue the loop.
          const chars = segment(word.content, 'grapheme')
          chars.unshift('')
          words.splice(i, 1, ...chars.map((c) => new InlineText(c, word.style)))
          if (_currentWidth > 0) {
            // Start a new line, spaces can be ignored.
            lineWidths.push(_currentWidth)
            baselines.push(currentBaselineOffset)
            lines++
            height += currentLineHeight
            _currentWidth = 0
            currentLineHeight = 0
            currentBaselineOffset = 0
            lineSegmentNumber.push(1)
            lineIndex = -1
          }
          continue
        }

        if (forceBreak || willWrap) {
          // Start a new line, spaces can be ignored.
          lineWidths.push(_currentWidth)
          baselines.push(currentBaselineOffset)
          lines++
          height += currentLineHeight
          _currentWidth = w
          currentLineHeight = w ? engine.height(word.content) : 0
          currentBaselineOffset = w ? engine.baseline(word.content) : 0
          lineSegmentNumber.push(1)
          lineIndex = -1

          // If it's naturally broken, we update the max width.
          // Since if there are multiple lines, the width should fit the
          // container.
          if (!forceBreak) {
            maxWidth = Math.max(maxWidth, width)
          }
        } else {
          // It fits into the current line.
          _currentWidth += remainingSpaceWidth + w
          const glyphHeight = engine.height(word.content)
          if (glyphHeight > currentLineHeight) {
            // Use the baseline of the highest segment as the baseline of the line.
            currentLineHeight = glyphHeight
            currentBaselineOffset = engine.baseline(word.content)
          }
          if (allowedToJustify) {
            lineSegmentNumber[lineSegmentNumber.length - 1]++
          }
        }

        remainingSpace = ''
        remainingSpaceWidth = 0

        if (allowedToJustify) {
          lineIndex++
        }

        maxWidth = Math.max(maxWidth, _currentWidth)
        wordPositionInLayout[i] = {
          y: height,
          x: _currentWidth - w,
          width: w,
          line: lines,
          lineIndex,
        }
      }
    }
    if (_currentWidth) {
      lines++
      lineWidths.push(_currentWidth)
      baselines.push(currentBaselineOffset)
      height += currentLineHeight
    }

    // @TODO: Support `line-height`.
    return { width: maxWidth, height }
  })

  const [x, y] = yield

  let result = ''
  let backgroundClipDef = ''

  const clipPathId = inheritedStyle._inheritedClipPathId as string | undefined
  const overflowMaskId = inheritedStyle._inheritedMaskId as number | undefined

  const {
    left: containerLeft,
    top: containerTop,
    width: containerWidth,
    height: containerHeight,
  } = textContainer.getComputedLayout()
  const parentContainerInnerWidth =
    parent.getComputedWidth() -
    parent.getComputedPadding(Yoga.EDGE_LEFT) -
    parent.getComputedPadding(Yoga.EDGE_RIGHT) -
    parent.getComputedBorder(Yoga.EDGE_LEFT) -
    parent.getComputedBorder(Yoga.EDGE_RIGHT)

  // Attach offset to the current node.
  const left = x + containerLeft
  const top = y + containerTop

  const { matrix, opacity } = container(
    {
      left: containerLeft,
      top: containerTop,
      width: containerWidth,
      height: containerHeight,
      isInheritingTransform,
    },
    parentStyle
  )

  let filter = ''
  if (parentStyle.textShadowOffset) {
    filter = dropShadow(
      {
        width: containerWidth,
        height: containerHeight,
        id,
      },
      {
        shadowColor: parentStyle.textShadowColor,
        shadowOffset: parentStyle.textShadowOffset,
        shadowRadius: parentStyle.textShadowRadius,
      }
    )
  }

  let decorationShape = ''
  let mergedPath = ''
  let extra = ''
  let skippedLine = -1
  let ellipsisWidth = textOverflow === 'ellipsis' ? measureWithCache(['…']) : 0
  let spaceWidth = textOverflow === 'ellipsis' ? measureWithCache([' ']) : 0
  let decorationLines: Record<number, null | number[]> = {}
  let wordBuffer: InlineText | null = null
  let bufferedOffset = 0

  for (let i = 0; i < words.length; i++) {
    // Skip whitespace and empty characters.
    if (!wordPositionInLayout[i]) continue
    const layout = wordPositionInLayout[i]

    let word = words[i]
    let path: string | null = null

    const image = graphemeImages ? graphemeImages[word.content] : null

    let topOffset = layout.y
    let leftOffset = layout.x
    const width = layout.width
    const line = layout.line

    if (line === skippedLine) {
      continue
    }

    // When `text-align` is `justify`, the width of the line will be adjusted.
    let extendedWidth = false

    if (lineWidths.length > 1) {
      // Calculate alignment. Note that for Flexbox, there is only text
      // alignment when the container is multi-line.
      const remainingWidth = containerWidth - lineWidths[line]
      if (textAlign === 'right' || textAlign === 'end') {
        leftOffset += remainingWidth
      } else if (textAlign === 'center') {
        leftOffset += remainingWidth / 2
      } else if (textAlign === 'justify') {
        // Don't justify the last line.
        if (line < lineWidths.length - 1) {
          const segments = lineSegmentNumber[line]
          const gutter = segments > 1 ? remainingWidth / (segments - 1) : 0
          leftOffset += gutter * layout.lineIndex
          extendedWidth = true
        }
      }
    }

    if (!decorationLines[line]) {
      decorationLines[line] = [
        leftOffset,
        extendedWidth ? containerWidth : lineWidths[line],
      ]
    }

    if (textOverflow === 'ellipsis') {
      if (lineWidths[line] > parentContainerInnerWidth) {
        if (
          layout.x + width + ellipsisWidth + spaceWidth >
          parentContainerInnerWidth
        ) {
          const chars = segment(word.content, 'grapheme', locale).map(
            (seg) => new InlineText(seg, word.style)
          )
          let subset = ''
          let resolvedWidth = 0
          for (const char of chars) {
            const w = layout.x + measureWithCache([subset + char])
            if (
              // Keep at least one character:
              // > The first character or atomic inline-level element on a line
              // must be clipped rather than ellipsed.
              // https://drafts.csswg.org/css-overflow/#text-overflow
              subset &&
              w + ellipsisWidth > parentContainerInnerWidth
            ) {
              break
            }
            subset += char
            resolvedWidth = w
          }
          word = new InlineText(subset + '…', word.style)
          skippedLine = line
          decorationLines[line][1] = resolvedWidth
        }
      }
    }

    const baselineOfLine = baselines[line]
    const baselineOfWord = engine.baseline(word.content)
    const heightOfWord = engine.height(word.content)
    const baselineDelta = baselineOfLine - baselineOfWord

    if (image) {
      // For images, we remove the baseline offset.
      topOffset += 0
    } else if (embedFont) {
      // If the current word and the next word are on the same line, we try to
      // merge them together to better handle the kerning.
      if (
        !wordSeparators.includes(word.content) &&
        words[i + 1] &&
        !graphemeImages[words[i + 1].content] &&
        wordPositionInLayout[i + 1] &&
        topOffset === wordPositionInLayout[i + 1].y &&
        areStylesEqual(words[i].style, words[i + 1].style)
      ) {
        if (wordBuffer === null) {
          bufferedOffset = leftOffset
        }
        wordBuffer =
          wordBuffer === null
            ? word
            : new InlineText(wordBuffer + word.content, word.style)
        continue
      }

      const finalizedSegment =
        wordBuffer === null
          ? word
          : new InlineText(wordBuffer.content + word.content, word.style)
      const finalizedLeftOffset =
        wordBuffer === null ? leftOffset : bufferedOffset
      const finalizedWidth = layout.width + leftOffset - finalizedLeftOffset

      path = engine.getSVG(finalizedSegment.content, {
        ...parentStyle,
        left: left + finalizedLeftOffset,
        // Since we need to pass the baseline position, add the ascender to the top.
        top: top + topOffset + baselineOfWord + baselineDelta,
        letterSpacing: parentStyle.letterSpacing,
      } as any)

      wordBuffer = null

      if (debug) {
        extra +=
          // Glyph
          buildXMLString('rect', {
            x: left + finalizedLeftOffset,
            y: top + topOffset + baselineDelta,
            width: finalizedWidth,
            height: heightOfWord,
            fill: 'transparent',
            stroke: '#575eff',
            'stroke-width': 1,
            transform: matrix ? matrix : undefined,
            'clip-path': clipPathId ? `url(#${clipPathId})` : undefined,
          }) +
          // Baseline
          buildXMLString('line', {
            x1: left + leftOffset,
            x2: left + leftOffset + layout.width,
            y1: top + topOffset + baselineDelta + baselineOfWord,
            y2: top + topOffset + baselineDelta + baselineOfWord,
            stroke: '#14c000',
            'stroke-width': 1,
            transform: matrix ? matrix : undefined,
            'clip-path': clipPathId ? `url(#${clipPathId})` : undefined,
          })
      }
    } else {
      // We need manually add the font ascender height to ensure it starts
      // at the baseline because <text>'s alignment baseline is set to `hanging`
      // by default and supported to change in SVG 1.1.
      topOffset += baselineOfWord + baselineDelta
    }

    // Get the decoration shape.
    if (parentStyle.textDecorationLine) {
      // If it's the last word in the current line.
      if (line !== wordPositionInLayout[i + 1]?.line || skippedLine === line) {
        const deco = decorationLines[line]
        if (deco && !deco[2]) {
          decorationShape += decoration(
            {
              left: left + deco[0],
              top: top + heightOfWord * +line,
              width: deco[1],
              ascender: engine.baseline(word.content),
              clipPathId,
            },
            parentStyle
          )
          deco[2] = 1
        }
      }
    }

    if (path !== null) {
      mergedPath += path + ' '
    } else {
      const [t, shape] = text(
        {
          content: word.content,
          filter,
          id,
          left: left + leftOffset,
          top: top + topOffset,
          width,
          height: heightOfWord,
          matrix,
          opacity,
          image,
          clipPathId,
          debug,
          shape: !!_inheritedBackgroundClipTextPath,
          decorationShape,
        },
        {
          ...parentStyle,
          color: word.style?.color ?? parentStyle.color,
        }
      )
      result += t
      backgroundClipDef += shape
      decorationShape = ''
    }
  }

  // Embed the font as path.
  if (mergedPath) {
    const p =
      parentStyle.color !== 'transparent' && opacity !== 0
        ? buildXMLString('path', {
            fill: parentStyle.color,
            d: mergedPath,
            transform: matrix ? matrix : undefined,
            opacity: opacity !== 1 ? opacity : undefined,
            'clip-path': clipPathId ? `url(#${clipPathId})` : undefined,
            mask: overflowMaskId ? `url(#${overflowMaskId})` : undefined,

            style: cssFilter ? `filter:${cssFilter}` : undefined,
          })
        : ''

    if (_inheritedBackgroundClipTextPath) {
      backgroundClipDef = buildXMLString('path', {
        d: mergedPath,
        transform: matrix ? matrix : undefined,
      })
    }

    result +=
      (filter
        ? filter +
          buildXMLString(
            'g',
            { filter: `url(#satori_s-${id})` },
            p + decorationShape
          )
        : p + decorationShape) + extra
  }

  // Attach information to the parent node.
  if (backgroundClipDef) {
    ;(parentStyle._inheritedBackgroundClipTextPath as any).value +=
      backgroundClipDef
  }

  return result
}

function areStylesEqual(
  a: Partial<InlineTextStyle> | undefined,
  b: Partial<InlineTextStyle> | undefined
) {
  if (a === undefined && b === undefined) {
    return true
  } else if (a === undefined || b === undefined) {
    return false
  }

  return a.color === b.color
}
