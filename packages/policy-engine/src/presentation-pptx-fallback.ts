import { createArtifactDesignPlan } from "./artifact-design.js";
import { resolvePresentationDeckLayoutPlan } from "./presentation-layout.js";
import { presentationTableRowHeights } from "./presentation-capacity.js";
import {
  presentationBulletSourceIds,
  presentationBulletText,
  presentationTableCellLayoutText,
  sourceMap,
  type PresentationBullet,
  type PresentationSlide,
  type PresentationSource,
  type PresentationTableCell,
} from "./presentation-model.js";
import type { PresentationPptxInput } from "./presentation-pptx.js";

export interface ZipEntry {
  name: string;
  data: Buffer;
}

const PRESENTATION_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

export function createFallbackPresentationPptx(input: PresentationPptxInput): Buffer {
  const contentSlides = input.slides.length > 0 ? input.slides : [{ title: input.title, bullets: [] }];
  const slides: PresentationSlide[] = [
    {
      title: input.title,
      bullets: input.subtitle ? [input.subtitle] : [],
    },
    ...contentSlides,
  ];
  const layoutNames = resolveFallbackPresentationLayoutNames(input, slides);
  const noteSlideNumbers = slides
    .map((slide, index) => (slide.speakerNotes?.trim() ? index + 1 : undefined))
    .filter((value): value is number => value !== undefined);
  const createdAt = input.createdAt ?? new Date();
  const entries: ZipEntry[] = [
    xmlEntry("[Content_Types].xml", buildContentTypes(slides.length, noteSlideNumbers)),
    xmlEntry("_rels/.rels", buildRootRelationships()),
    xmlEntry("docProps/core.xml", buildCoreProperties(input.title, createdAt)),
    xmlEntry("docProps/app.xml", buildAppProperties(slides.length, noteSlideNumbers.length)),
    xmlEntry("ppt/presentation.xml", buildPresentationXml(slides.length, noteSlideNumbers.length > 0)),
    xmlEntry(
      "ppt/_rels/presentation.xml.rels",
      buildPresentationRelationships(slides.length, noteSlideNumbers.length > 0),
    ),
    xmlEntry("ppt/slideMasters/slideMaster1.xml", buildSlideMasterXml()),
    xmlEntry("ppt/slideMasters/_rels/slideMaster1.xml.rels", buildSlideMasterRelationships()),
    xmlEntry("ppt/slideLayouts/slideLayout1.xml", buildSlideLayoutXml()),
    xmlEntry("ppt/slideLayouts/_rels/slideLayout1.xml.rels", buildSlideLayoutRelationships()),
    xmlEntry("ppt/theme/theme1.xml", buildThemeXml()),
  ];
  if (noteSlideNumbers.length > 0) {
    entries.push(
      xmlEntry("ppt/notesMasters/notesMaster1.xml", buildNotesMasterXml()),
      xmlEntry("ppt/notesMasters/_rels/notesMaster1.xml.rels", buildNotesMasterRelationships()),
    );
  }
  slides.forEach((slide, index) => {
    entries.push(
      xmlEntry(
        `ppt/slides/slide${index + 1}.xml`,
        buildSlideXml(slide, index, input.sources ?? [], layoutNames[index] ?? (index === 0 ? "hero" : "image-text")),
      ),
    );
    entries.push(
      xmlEntry(
        `ppt/slides/_rels/slide${index + 1}.xml.rels`,
        buildSlideRelationships(slide, input.sources ?? [], index + 1),
      ),
    );
    if (slide.speakerNotes?.trim()) {
      entries.push(
        xmlEntry(`ppt/notesSlides/notesSlide${index + 1}.xml`, buildNotesSlideXml(slide.speakerNotes)),
        xmlEntry(`ppt/notesSlides/_rels/notesSlide${index + 1}.xml.rels`, buildNotesSlideRelationships(index + 1)),
      );
    }
  });
  return createStoredZip(entries);
}

export function resolveFallbackPresentationLayoutNames(
  input: PresentationPptxInput,
  preparedSlides?: PresentationSlide[],
): string[] {
  const contentSlides =
    preparedSlides ?? (input.slides.length > 0 ? input.slides : [{ title: input.title, bullets: [] }]);
  const slides: PresentationSlide[] = preparedSlides
    ? contentSlides
    : [{ title: input.title, bullets: input.subtitle ? [input.subtitle] : [] }, ...contentSlides];
  const design =
    input.design ??
    createArtifactDesignPlan({
      kind: "presentation",
      title: input.title,
      body: input.subtitle,
      slides: input.slides.map((slide) => ({
        title: slide.title,
        bullets: slide.bullets.map(presentationBulletText),
        speakerNotes: slide.speakerNotes,
      })),
      format: "pptx",
    });
  return resolvePresentationDeckLayoutPlan(design, slides).map((decision) => decision.renderer);
}

function xmlEntry(name: string, xml: string): ZipEntry {
  return { name, data: Buffer.from(xml, "utf8") };
}

function buildContentTypes(slideCount: number, noteSlideNumbers: readonly number[]): string {
  const slideOverrides = Array.from(
    { length: slideCount },
    (_, index) =>
      `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
  ).join("");
  const noteOverrides = noteSlideNumbers
    .map(
      (slideNumber) =>
        `<Override PartName="/ppt/notesSlides/notesSlide${slideNumber}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`,
    )
    .join("");
  return xmlDocument(
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
      `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
      `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
      `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>` +
      `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>` +
      `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
      (noteSlideNumbers.length > 0
        ? `<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>`
        : "") +
      slideOverrides +
      noteOverrides +
      `</Types>`,
  );
}

function buildRootRelationships(): string {
  return xmlDocument(
    `<Relationships xmlns="${PACKAGE_REL_NS}">` +
      `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="ppt/presentation.xml"/>` +
      `<Relationship Id="rId2" Type="${PACKAGE_REL_NS}/metadata/core-properties" Target="docProps/core.xml"/>` +
      `<Relationship Id="rId3" Type="${REL_NS}/extended-properties" Target="docProps/app.xml"/>` +
      `</Relationships>`,
  );
}

function buildCoreProperties(title: string, createdAt: Date): string {
  const timestamp = createdAt.toISOString();
  return xmlDocument(
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
      `xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
      `xmlns:dcterms="http://purl.org/dc/terms/" ` +
      `xmlns:dcmitype="http://purl.org/dc/dcmitype/" ` +
      `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
      `<dc:title>${escapeXml(title)}</dc:title>` +
      `<dc:creator>GoatCitadel</dc:creator>` +
      `<cp:lastModifiedBy>GoatCitadel</cp:lastModifiedBy>` +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:created>` +
      `<dcterms:modified xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:modified>` +
      `</cp:coreProperties>`,
  );
}

function buildAppProperties(slideCount: number, noteCount: number): string {
  return xmlDocument(
    `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ` +
      `xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
      `<Application>GoatCitadel</Application>` +
      `<PresentationFormat>Widescreen</PresentationFormat>` +
      `<Slides>${slideCount}</Slides>` +
      `<Notes>${noteCount}</Notes>` +
      `<HiddenSlides>0</HiddenSlides>` +
      `<MMClips>0</MMClips>` +
      `<ScaleCrop>false</ScaleCrop>` +
      `</Properties>`,
  );
}

function buildPresentationXml(slideCount: number, hasNotes: boolean): string {
  const slideIds = Array.from(
    { length: slideCount },
    (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`,
  ).join("");
  return xmlDocument(
    `<p:presentation xmlns:a="${DRAWING_NS}" xmlns:r="${REL_NS}" xmlns:p="${PRESENTATION_NS}">` +
      `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
      (hasNotes ? `<p:notesMasterIdLst><p:notesMasterId r:id="rId${slideCount + 2}"/></p:notesMasterIdLst>` : "") +
      `<p:sldIdLst>${slideIds}</p:sldIdLst>` +
      `<p:sldSz cx="12192000" cy="6858000" type="wide"/>` +
      `<p:notesSz cx="6858000" cy="9144000"/>` +
      `<p:defaultTextStyle/>` +
      `</p:presentation>`,
  );
}

function buildPresentationRelationships(slideCount: number, hasNotes: boolean): string {
  const slideRelationships = Array.from(
    { length: slideCount },
    (_, index) => `<Relationship Id="rId${index + 2}" Type="${REL_NS}/slide" Target="slides/slide${index + 1}.xml"/>`,
  ).join("");
  return xmlDocument(
    `<Relationships xmlns="${PACKAGE_REL_NS}">` +
      `<Relationship Id="rId1" Type="${REL_NS}/slideMaster" Target="slideMasters/slideMaster1.xml"/>` +
      slideRelationships +
      (hasNotes
        ? `<Relationship Id="rId${slideCount + 2}" Type="${REL_NS}/notesMaster" Target="notesMasters/notesMaster1.xml"/>`
        : "") +
      `</Relationships>`,
  );
}

function buildSlideXml(
  slide: PresentationSlide,
  index: number,
  sources: readonly PresentationSource[],
  layoutName: string,
): string {
  const titleShape = textShape({
    id: 2,
    name: "gc:title",
    x: 609600,
    y: 365760,
    cx: 10972800,
    cy: 914400,
    paragraphs: [runParagraph(slide.title, index === 0 ? 3600 : 2800, true)],
  });
  const links = fallbackSlideLinks(slide, sources);
  const relationshipBySourceId = new Map(links.map((link, linkIndex) => [link.sourceId, `rId${linkIndex + 2}`]));
  const subtitle = index === 0 && slide.bullets[0] ? presentationBulletText(slide.bullets[0]) : undefined;
  const subtitleShape = subtitle
    ? textShape({
        id: 3,
        name: "gc:subtitle",
        x: 914400,
        y: 1554480,
        cx: 10363200,
        cy: 1097280,
        paragraphs: [runParagraph(subtitle, 1800, false)],
      })
    : "";
  const bodyParagraphs = index === 0 ? [] : buildFallbackBodyParagraphs(slide, relationshipBySourceId);
  const bodyShape =
    bodyParagraphs.length > 0
      ? textShape({
          id: 3,
          name: slide.generatedSourceAppendix ? "gc:source" : "gc:body",
          x: 914400,
          y: 1554480,
          cx: 10363200,
          cy: 4724400,
          paragraphs: bodyParagraphs,
        })
      : "";
  const dataTable = buildFallbackDataTable(slide, relationshipBySourceId);
  const continuationRail = layoutName.endsWith("-continuation") ? continuationRailShape(7) : "";
  const slideNumberShape = textShape({
    id: 6,
    name: "gc:slide-number",
    x: 10972800,
    y: 6355080,
    cx: 548640,
    cy: 274320,
    paragraphs: [runParagraph(String(index + 1).padStart(2, "0"), 1000, true)],
  });
  return xmlDocument(
    `<p:sld xmlns:a="${DRAWING_NS}" xmlns:r="${REL_NS}" xmlns:p="${PRESENTATION_NS}">` +
      `<p:cSld><p:spTree>` +
      `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
      `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
      layoutSignatureShape(4, layoutName) +
      continuationRail +
      titleShape +
      subtitleShape +
      bodyShape +
      dataTable +
      slideNumberShape +
      `</p:spTree></p:cSld>` +
      `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>` +
      `</p:sld>`,
  );
}

function buildSlideRelationships(
  slide: PresentationSlide,
  sources: readonly PresentationSource[],
  slideNumber: number,
): string {
  const links = fallbackSlideLinks(slide, sources);
  const hyperlinks = links
    .map(
      (link, index) =>
        `<Relationship Id="rId${index + 2}" Type="${REL_NS}/hyperlink" Target="${escapeXml(link.url)}" TargetMode="External"/>`,
    )
    .join("");
  return xmlDocument(
    `<Relationships xmlns="${PACKAGE_REL_NS}">` +
      `<Relationship Id="rId1" Type="${REL_NS}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
      hyperlinks +
      (slide.speakerNotes?.trim()
        ? `<Relationship Id="rId${links.length + 2}" Type="${REL_NS}/notesSlide" Target="../notesSlides/notesSlide${slideNumber}.xml"/>`
        : "") +
      `</Relationships>`,
  );
}

function buildNotesMasterXml(): string {
  return xmlDocument(
    `<p:notesMaster xmlns:a="${DRAWING_NS}" xmlns:r="${REL_NS}" xmlns:p="${PRESENTATION_NS}">` +
      `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
      `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
      `</p:spTree></p:cSld>` +
      `<p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/>` +
      `<p:hf hdr="0" ftr="0" dt="1" sldNum="1"/><p:notesStyle/>` +
      `</p:notesMaster>`,
  );
}

function buildNotesMasterRelationships(): string {
  return xmlDocument(
    `<Relationships xmlns="${PACKAGE_REL_NS}">` +
      `<Relationship Id="rId1" Type="${REL_NS}/theme" Target="../theme/theme1.xml"/>` +
      `</Relationships>`,
  );
}

function buildNotesSlideXml(notes: string): string {
  return xmlDocument(
    `<p:notes xmlns:a="${DRAWING_NS}" xmlns:r="${REL_NS}" xmlns:p="${PRESENTATION_NS}">` +
      `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
      `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
      textShape({
        id: 2,
        name: "gc:authored-notes",
        x: 457200,
        y: 457200,
        cx: 5943600,
        cy: 7772400,
        paragraphs: [runParagraph(notes, 1200, false)],
      }) +
      `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`,
  );
}

function buildNotesSlideRelationships(slideNumber: number): string {
  return xmlDocument(
    `<Relationships xmlns="${PACKAGE_REL_NS}">` +
      `<Relationship Id="rId1" Type="${REL_NS}/notesMaster" Target="../notesMasters/notesMaster1.xml"/>` +
      `<Relationship Id="rId2" Type="${REL_NS}/slide" Target="../slides/slide${slideNumber}.xml"/>` +
      `</Relationships>`,
  );
}

function buildSlideMasterXml(): string {
  return xmlDocument(
    `<p:sldMaster xmlns:a="${DRAWING_NS}" xmlns:r="${REL_NS}" xmlns:p="${PRESENTATION_NS}">` +
      `<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="111827"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` +
      `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
      `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
      `</p:spTree></p:cSld>` +
      `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
      `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
      `<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles>` +
      `</p:sldMaster>`,
  );
}

function buildSlideMasterRelationships(): string {
  return xmlDocument(
    `<Relationships xmlns="${PACKAGE_REL_NS}">` +
      `<Relationship Id="rId1" Type="${REL_NS}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
      `<Relationship Id="rId2" Type="${REL_NS}/theme" Target="../theme/theme1.xml"/>` +
      `</Relationships>`,
  );
}

function buildSlideLayoutXml(): string {
  return xmlDocument(
    `<p:sldLayout xmlns:a="${DRAWING_NS}" xmlns:r="${REL_NS}" xmlns:p="${PRESENTATION_NS}" type="blank" preserve="1">` +
      `<p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
      `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
      `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
  );
}

function buildSlideLayoutRelationships(): string {
  return xmlDocument(
    `<Relationships xmlns="${PACKAGE_REL_NS}">` +
      `<Relationship Id="rId1" Type="${REL_NS}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>` +
      `</Relationships>`,
  );
}

function buildThemeXml(): string {
  return xmlDocument(
    `<a:theme xmlns:a="${DRAWING_NS}" name="GoatCitadel">` +
      `<a:themeElements><a:clrScheme name="GoatCitadel">` +
      `<a:dk1><a:srgbClr val="111827"/></a:dk1><a:lt1><a:srgbClr val="F8FAFC"/></a:lt1>` +
      `<a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="E5E7EB"/></a:lt2>` +
      `<a:accent1><a:srgbClr val="2DD4BF"/></a:accent1><a:accent2><a:srgbClr val="60A5FA"/></a:accent2>` +
      `<a:accent3><a:srgbClr val="F472B6"/></a:accent3><a:accent4><a:srgbClr val="FBBF24"/></a:accent4>` +
      `<a:accent5><a:srgbClr val="A78BFA"/></a:accent5><a:accent6><a:srgbClr val="34D399"/></a:accent6>` +
      `<a:hlink><a:srgbClr val="60A5FA"/></a:hlink><a:folHlink><a:srgbClr val="A78BFA"/></a:folHlink>` +
      `</a:clrScheme><a:fontScheme name="Aptos"><a:majorFont><a:latin typeface="Aptos Display"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>` +
      `<a:fmtScheme name="GoatCitadel">` +
      `<a:fillStyleLst>` +
      `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
      `<a:solidFill><a:schemeClr val="accent1"/></a:solidFill>` +
      `<a:solidFill><a:schemeClr val="accent2"/></a:solidFill>` +
      `</a:fillStyleLst>` +
      `<a:lnStyleLst>` +
      `<a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>` +
      `<a:ln w="25400"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:ln>` +
      `<a:ln w="38100"><a:solidFill><a:schemeClr val="accent2"/></a:solidFill></a:ln>` +
      `</a:lnStyleLst>` +
      `<a:effectStyleLst>` +
      `<a:effectStyle><a:effectLst/></a:effectStyle>` +
      `<a:effectStyle><a:effectLst/></a:effectStyle>` +
      `<a:effectStyle><a:effectLst/></a:effectStyle>` +
      `</a:effectStyleLst>` +
      `<a:bgFillStyleLst>` +
      `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
      `<a:solidFill><a:schemeClr val="lt1"/></a:solidFill>` +
      `<a:solidFill><a:schemeClr val="dk1"/></a:solidFill>` +
      `</a:bgFillStyleLst>` +
      `</a:fmtScheme>` +
      `</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`,
  );
}

function textShape(input: {
  id: number;
  name: string;
  x: number;
  y: number;
  cx: number;
  cy: number;
  paragraphs: string[];
}): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${input.id}" name="${escapeXml(input.name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${input.x}" y="${input.y}"/><a:ext cx="${input.cx}" cy="${input.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${input.paragraphs.join("")}</p:txBody></p:sp>`
  );
}

function layoutSignatureShape(id: number, layoutName: string): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="gc:layout:${escapeXml(layoutName)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9144" cy="9144"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FFFFFF"><a:alpha val="0"/></a:srgbClr></a:solidFill>` +
    `<a:ln><a:noFill/></a:ln></p:spPr></p:sp>`
  );
}

function continuationRailShape(id: number): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="gc:continuation-rail"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="557784" y="1371600"/><a:ext cx="64008" cy="4114800"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="60A5FA"/></a:solidFill>` +
    `<a:ln><a:noFill/></a:ln></p:spPr></p:sp>`
  );
}

function buildFallbackDataTable(slide: PresentationSlide, relationshipBySourceId: ReadonlyMap<string, string>): string {
  if (slide.table) {
    return tableGraphicFrame(
      5,
      "gc:table",
      slide.table.headers,
      slide.table.rows,
      relationshipBySourceId,
      Boolean(slide.bullets.length),
    );
  }
  if (slide.chart) {
    const headers: PresentationTableCell[] = [
      { text: "Category" },
      ...slide.chart.series.map((series) => ({ text: series.name })),
    ];
    const rows = slide.chart.categories.map((category, index) => [
      { text: category },
      ...slide.chart!.series.map((series) => ({ text: String(series.values[index] ?? "") })),
    ]);
    return tableGraphicFrame(5, "gc:table:chart-data", headers, rows, relationshipBySourceId, true);
  }
  return "";
}

function tableGraphicFrame(
  id: number,
  name: string,
  headers: readonly PresentationTableCell[],
  rows: readonly PresentationTableCell[][],
  relationshipBySourceId: ReadonlyMap<string, string>,
  hasIntro: boolean,
): string {
  const x = 694944;
  const y = hasIntro ? 2286000 : 1554480;
  const cx = 10622208;
  const cy = hasIntro ? 3200400 : 3931920;
  const columnWidth = Math.floor(cx / Math.max(headers.length, 1));
  const allRows = [headers, ...rows];
  const rowHeights = presentationTableRowHeights(
    headers.map(presentationTableCellLayoutText),
    rows.map((row) => row.map(presentationTableCellLayoutText)),
  ).map((height) => Math.floor(height * 914400));
  const grid = headers.map(() => `<a:gridCol w="${columnWidth}"/>`).join("");
  const tableRows = allRows
    .map((row, rowIndex) => {
      const cells = row.map((cell) => tableCellXml(cell, rowIndex === 0, relationshipBySourceId)).join("");
      return `<a:tr h="${rowHeights[rowIndex] ?? Math.floor(cy / Math.max(allRows.length, 1))}">${cells}</a:tr>`;
    })
    .join("");
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${escapeXml(name)}"/>` +
    `<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></p:xfrm>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">` +
    `<a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${grid}</a:tblGrid>${tableRows}</a:tbl>` +
    `</a:graphicData></a:graphic></p:graphicFrame>`
  );
}

function tableCellXml(
  cell: PresentationTableCell,
  header: boolean,
  relationshipBySourceId: ReadonlyMap<string, string>,
): string {
  const paragraph = richParagraph(cell.text, 1400, header, cell.sourceIds ?? [], relationshipBySourceId);
  const fill = header
    ? `<a:solidFill><a:srgbClr val="1F2937"/></a:solidFill>`
    : `<a:solidFill><a:srgbClr val="111827"/></a:solidFill>`;
  return (
    `<a:tc><a:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${paragraph}</a:txBody>` +
    `<a:tcPr marL="73152" marR="73152" marT="45720" marB="45720">${fill}</a:tcPr></a:tc>`
  );
}

function buildFallbackBodyParagraphs(
  slide: PresentationSlide,
  relationshipBySourceId: ReadonlyMap<string, string>,
): string[] {
  const paragraphs: string[] = [];
  slide.bullets.forEach((bullet) => {
    paragraphs.push(
      slide.generatedSourceAppendix
        ? sourceParagraph(bullet, relationshipBySourceId)
        : bulletParagraph(bullet, relationshipBySourceId),
    );
  });
  if (slide.chart) {
    paragraphs.push(
      richParagraph(
        "Chart unavailable in compatibility renderer; data shown as a table.",
        1600,
        true,
        [...(slide.chart.sourceIds ?? []), ...slide.chart.series.flatMap((series) => series.sourceIds ?? [])],
        relationshipBySourceId,
      ),
    );
  }
  return paragraphs;
}

function sourceParagraph(bullet: PresentationBullet, relationshipBySourceId: ReadonlyMap<string, string>): string {
  const hyperlinkId = presentationBulletSourceIds(bullet)
    .map((sourceId) => relationshipBySourceId.get(sourceId))
    .find(Boolean);
  return `<a:p>${textRunXml(presentationBulletText(bullet), 1200, false, hyperlinkId)}</a:p>`;
}

function fallbackSlideLinks(
  slide: PresentationSlide,
  sources: readonly PresentationSource[],
): Array<{ sourceId: string; url: string }> {
  const ids = new Set(slide.bullets.flatMap(presentationBulletSourceIds));
  slide.table?.headers.forEach((cell) => cell.sourceIds?.forEach((id) => ids.add(id)));
  slide.table?.rows.flat().forEach((cell) => cell.sourceIds?.forEach((id) => ids.add(id)));
  slide.chart?.sourceIds?.forEach((id) => ids.add(id));
  slide.chart?.series.forEach((series) => series.sourceIds?.forEach((id) => ids.add(id)));
  const byId = sourceMap(sources);
  return [...ids]
    .map((sourceId) => ({ sourceId, url: byId.get(sourceId)?.url }))
    .filter((item): item is { sourceId: string; url: string } => Boolean(item.url));
}

function runParagraph(text: string, size: number, bold: boolean, hyperlinkId?: string): string {
  const hyperlink = hyperlinkId ? `<a:hlinkClick r:id="${hyperlinkId}"/>` : "";
  return `<a:p><a:r><a:rPr lang="en-US" sz="${size}"${bold ? ` b="1"` : ""}><a:solidFill><a:srgbClr val="F8FAFC"/></a:solidFill>${hyperlink}</a:rPr><a:t>${escapeXml(text)}</a:t></a:r></a:p>`;
}

function bulletParagraph(bullet: PresentationBullet, relationshipBySourceId: ReadonlyMap<string, string>): string {
  return richParagraph(
    presentationBulletText(bullet),
    1600,
    false,
    presentationBulletSourceIds(bullet),
    relationshipBySourceId,
    `<a:pPr marL="342900" indent="-171450"><a:buChar char="-"/></a:pPr>`,
  );
}

function richParagraph(
  text: string,
  size: number,
  bold: boolean,
  sourceIds: readonly string[],
  relationshipBySourceId: ReadonlyMap<string, string>,
  paragraphProperties = "",
): string {
  const textRun = textRunXml(text, size, bold);
  const citationRuns = [...new Set(sourceIds)]
    .map((sourceId, index) => {
      const hyperlinkId = relationshipBySourceId.get(sourceId);
      return hyperlinkId ? textRunXml(` [${index + 1}]`, size, false, hyperlinkId) : "";
    })
    .join("");
  return `<a:p>${paragraphProperties}${textRun}${citationRuns}</a:p>`;
}

function textRunXml(text: string, size: number, bold: boolean, hyperlinkId?: string): string {
  const hyperlink = hyperlinkId ? `<a:hlinkClick r:id="${hyperlinkId}"/>` : "";
  return `<a:r><a:rPr lang="en-US" sz="${size}"${bold ? ` b="1"` : ""}><a:solidFill><a:srgbClr val="F8FAFC"/></a:solidFill>${hyperlink}</a:rPr><a:t>${escapeXml(text)}</a:t></a:r>`;
}

function xmlDocument(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`;
}

function escapeXml(value: string): string {
  return (
    value
      // eslint-disable-next-line no-control-regex -- strip C0 control chars illegal in XML 1.0 (tab/newline/CR preserved)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
      .replace(/[<>&"']/g, (char) => {
        switch (char) {
          case "<":
            return "&lt;";
          case ">":
            return "&gt;";
          case "&":
            return "&amp;";
          case '"':
            return "&quot;";
          default:
            return "&apos;";
        }
      })
  );
}

export function createStoredZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const crc = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);
    offset += localHeader.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(offset, 16);
  endRecord.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, endRecord]);
}

const CRC32_TABLE = makeCrc32Table();

function makeCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ (CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
