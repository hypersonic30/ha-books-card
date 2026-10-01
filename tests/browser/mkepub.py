import zipfile, sys
def chapter(n, title):
    body = "".join(f"<p>Kapitel {n}, Absatz {i}. " + "Lorem ipsum dolor sit amet, consectetur adipiscing elit. " * 12 + "</p>" for i in range(1, 25))
    return f'<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>{title}</title></head><body><h1>{title}</h1>{body}</body></html>'
CH = [("Vorwort", "text/c1.xhtml", 0), ("Teil Eins", "text/c2.xhtml", 0), ("Erstes Kapitel", "text/c3.xhtml", 1), ("Ende", "text/c4.xhtml", 0)]
def build(path, version):
    z = zipfile.ZipFile(path, "w")
    z.writestr("mimetype", "application/epub+zip", zipfile.ZIP_STORED)
    z.writestr("META-INF/container.xml", '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
    manifest = "".join(f'<item id="c{i+1}" href="{h}" media-type="application/xhtml+xml"/>' for i, (_, h, _) in enumerate(CH))
    spine = "".join(f'<itemref idref="c{i+1}"/>' for i in range(len(CH)))
    if version == 3:
        manifest += '<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>'
        # nested: "Erstes Kapitel" is a child of "Teil Eins"
        nav = ('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>toc</title></head><body><nav epub:type="toc"><ol>'
               '<li><a href="text/c1.xhtml">Vorwort</a></li><li><a href="text/c2.xhtml">Teil Eins</a><ol><li><a href="text/c3.xhtml">Erstes Kapitel</a></li></ol></li><li><a href="text/c4.xhtml">Ende</a></li></ol></nav></body></html>')
        z.writestr("OEBPS/nav.xhtml", nav); extra = ""
    else:
        manifest += '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'
        pts = "".join(f'<navPoint id="n{i}" playOrder="{i}"><navLabel><text>{t}</text></navLabel><content src="{h}"/></navPoint>' for i, (t, h, _) in enumerate(CH, 1))
        z.writestr("OEBPS/toc.ncx", f'<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head/><docTitle><text>T</text></docTitle><navMap>{pts}</navMap></ncx>')
        extra = ' toc="ncx"'
    z.writestr("OEBPS/content.opf", f'<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="{"3.0" if version == 3 else "2.0"}" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">x{version}</dc:identifier><dc:title>Testbuch {version}</dc:title><dc:language>de</dc:language>{"<meta property=\"dcterms:modified\">2026-01-01T00:00:00Z</meta>" if version == 3 else ""}</metadata><manifest>{manifest}</manifest><spine{extra}>{spine}</spine></package>')
    for i, (t, h, _) in enumerate(CH, 1): z.writestr("OEBPS/" + h, chapter(i, t))
    z.close()
build(sys.argv[1] + "/epub3.epub", 3); build(sys.argv[1] + "/epub2.epub", 2)
