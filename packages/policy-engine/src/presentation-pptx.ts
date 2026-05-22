export interface PresentationSlide {
  title: string;
  bullets: string[];
  speakerNotes?: string;
}

export interface PresentationPptxInput {
  title: string;
  subtitle?: string;
  slides: PresentationSlide[];
  createdAt?: Date;
}

export interface ZipEntry {
  name: string;
  data: Buffer;
}

const PRESENTATION_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

export function createPresentationPptx(input: PresentationPptxInput): Buffer {
  const contentSlides = input.slides.length > 0 ? input.slides : [{ title: input.title, bullets: [] }];
  const slides: PresentationSlide[] = [
    {
      title: input.title,
      bullets: input.subtitle ? [input.subtitle] : [],
    },
    ...contentSlides,
  ];
  const createdAt = input.createdAt ?? new Date();
  const entries: ZipEntry[] = [
    xmlEntry("[Content_Types].xml", buildContentTypes(slides.length)),
    xmlEntry("_rels/.rels", buildRootRelationships()),
    xmlEntry("docProps/core.xml", buildCoreProperties(input.title, createdAt)),
    xmlEntry("docProps/app.xml", buildAppProperties(slides.length)),
    xmlEntry("ppt/presentation.xml", buildPresentationXml(slides.length)),
    xmlEntry("ppt/_rels/presentation.xml.rels", buildPresentationRelationships(slides.length)),
    xmlEntry("ppt/slideMasters/slideMaster1.xml", buildSlideMasterXml()),
    xmlEntry("ppt/slideMasters/_rels/slideMaster1.xml.rels", buildSlideMasterRelationships()),
    xmlEntry("ppt/slideLayouts/slideLayout1.xml", buildSlideLayoutXml()),
    xmlEntry("ppt/slideLayouts/_rels/slideLayout1.xml.rels", buildSlideLayoutRelationships()),
    xmlEntry("ppt/theme/theme1.xml", buildThemeXml()),
  ];
  slides.forEach((slide, index) => {
    entries.push(xmlEntry(`ppt/slides/slide${index + 1}.xml`, buildSlideXml(slide, index)));
    entries.push(xmlEntry(`ppt/slides/_rels/slide${index + 1}.xml.rels`, buildSlideRelationships()));
  });
  return createStoredZip(entries);
}

function xmlEntry(name: string, xml: string): ZipEntry {
  return { name, data: Buffer.from(xml, "utf8") };
}

function buildContentTypes(slideCount: number): string {
  const slideOverrides = Array.from(
    { length: slideCount },
    (_, index) =>
      `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
  ).join("");
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
      slideOverrides +
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

function buildAppProperties(slideCount: number): string {
  return xmlDocument(
    `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ` +
      `xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
      `<Application>GoatCitadel</Application>` +
      `<PresentationFormat>Widescreen</PresentationFormat>` +
      `<Slides>${slideCount}</Slides>` +
      `<Notes>0</Notes>` +
      `<HiddenSlides>0</HiddenSlides>` +
      `<MMClips>0</MMClips>` +
      `<ScaleCrop>false</ScaleCrop>` +
      `</Properties>`,
  );
}

function buildPresentationXml(slideCount: number): string {
  const slideIds = Array.from(
    { length: slideCount },
    (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`,
  ).join("");
  return xmlDocument(
    `<p:presentation xmlns:a="${DRAWING_NS}" xmlns:r="${REL_NS}" xmlns:p="${PRESENTATION_NS}">` +
      `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
      `<p:sldIdLst>${slideIds}</p:sldIdLst>` +
      `<p:sldSz cx="12192000" cy="6858000" type="wide"/>` +
      `<p:notesSz cx="6858000" cy="9144000"/>` +
      `<p:defaultTextStyle/>` +
      `</p:presentation>`,
  );
}

function buildPresentationRelationships(slideCount: number): string {
  const slideRelationships = Array.from(
    { length: slideCount },
    (_, index) => `<Relationship Id="rId${index + 2}" Type="${REL_NS}/slide" Target="slides/slide${index + 1}.xml"/>`,
  ).join("");
  return xmlDocument(
    `<Relationships xmlns="${PACKAGE_REL_NS}">` +
      `<Relationship Id="rId1" Type="${REL_NS}/slideMaster" Target="slideMasters/slideMaster1.xml"/>` +
      slideRelationships +
      `</Relationships>`,
  );
}

function buildSlideXml(slide: PresentationSlide, index: number): string {
  const titleShape = textShape({
    id: 2,
    name: "Title",
    x: 609600,
    y: 365760,
    cx: 10972800,
    cy: 914400,
    paragraphs: [runParagraph(slide.title, 3600, true)],
  });
  const bodyParagraphs =
    slide.bullets.length > 0
      ? slide.bullets.map((bullet) => bulletParagraph(bullet))
      : [runParagraph(index === 0 ? "Generated by GoatCitadel." : "No details provided.", 2200, false)];
  const bodyShape = textShape({
    id: 3,
    name: "Body",
    x: 914400,
    y: 1554480,
    cx: 10363200,
    cy: 4724400,
    paragraphs: bodyParagraphs,
  });
  return xmlDocument(
    `<p:sld xmlns:a="${DRAWING_NS}" xmlns:r="${REL_NS}" xmlns:p="${PRESENTATION_NS}">` +
      `<p:cSld><p:spTree>` +
      `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
      `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
      titleShape +
      bodyShape +
      `</p:spTree></p:cSld>` +
      `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>` +
      `</p:sld>`,
  );
}

function buildSlideRelationships(): string {
  return xmlDocument(
    `<Relationships xmlns="${PACKAGE_REL_NS}">` +
      `<Relationship Id="rId1" Type="${REL_NS}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
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

function runParagraph(text: string, size: number, bold: boolean): string {
  return `<a:p><a:r><a:rPr lang="en-US" sz="${size}"${bold ? ` b="1"` : ""}><a:solidFill><a:srgbClr val="F8FAFC"/></a:solidFill></a:rPr><a:t>${escapeXml(text)}</a:t></a:r></a:p>`;
}

function bulletParagraph(text: string): string {
  return `<a:p><a:pPr marL="342900" indent="-171450"><a:buChar char="-"/></a:pPr><a:r><a:rPr lang="en-US" sz="2200"><a:solidFill><a:srgbClr val="E5E7EB"/></a:solidFill></a:rPr><a:t>${escapeXml(text)}</a:t></a:r></a:p>`;
}

function xmlDocument(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => {
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
  });
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
