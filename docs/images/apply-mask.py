#!/usr/bin/env python3
"""Apply masking to every README screenshot.

Each screenshot shows a different surface, so each needs its own region list.
The list columns are masked row by row (located by their separator rules); the
dialog and hover-card regions are masked by explicit box.
"""
import os
import sys
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mask import mask_list, mask_region, TITLE, SUB  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


def overview(img):
    """Panel list: titles (with badges and chips) + workspace sub-lines."""
    return mask_list(img, 88, 700, 300, img.size[1], 'Session')


def tag_manager(img):
    """Tag manager dialog: the vocabulary rows, plus the list behind it."""
    for index, y in enumerate((396, 448, 500), start=1):
        mask_region(img, (88, y, 300, y + 20), 'tag-%d' % index, 13, TITLE)
        mask_region(img, (300, y, 560, y + 20), 'manual', 11, SUB)
    # The session list visible below the dialog: explicit bands, because the
    # dialog's shadow breaks separator detection there.
    rows = [
        (612, 652, 652, 666),
        (664, 686, 686, 700),
        (704, 724, 724, 738),
        (740, 776, 776, 790),
        (790, 828, 828, 842),
        (842, 870, 870, 870),
    ]
    for index, (ty0, ty1, sy0, sy1) in enumerate(rows, start=1):
        mask_region(img, (88, ty0, 700, ty1), 'Session %d' % index, 13, TITLE)
        if sy1 > sy0:
            mask_region(img, (88, sy0, 700, sy1), 'workspace-%d' % index, 11, SUB)
    return 3 + len(rows)


def native_menu(img):
    """Native context menu: the tag submenu entries, plus the list behind it.

    The open menu overlays the list, so the list is masked by explicit bands
    rather than by separator detection.
    """
    # The submenu entries sit lower than the parent menu's rows.
    for index, y in enumerate((370, 404, 438), start=1):
        mask_region(img, (330, y, 470, y + 20), 'tag-%d' % index, 13, TITLE)
    for index, y in enumerate((410, 444, 478), start=1):
        mask_region(img, (330, y, 470, y + 20), 'tag-%d' % index, 13, TITLE)
    # The submenu's own rows sit lower still, over the list.
    for index, y in enumerate((616, 650, 684), start=1):
        mask_region(img, (310, y, 480, y + 20), 'tag-%d' % index, 13, TITLE)
    rows = [
        (330, 348, 348, 362),
        (366, 390, 390, 404),
        (426, 448, 448, 462),
        (462, 490, 490, 504),
        (512, 540, 540, 554),
        (566, 600, 600, 614),
        (610, 642, 642, 656),
        (666, 690, 690, 704),
        (718, 740, 740, 754),
        (742, 776, 776, 790),
        (786, 818, 818, 832),
        (826, 850, 850, 864),
    ]
    for index, (ty0, ty1, sy0, sy1) in enumerate(rows, start=1):
        mask_region(img, (88, ty0, 700, ty1), 'Session %d' % index, 13, TITLE)
        mask_region(img, (88, sy0, 700, sy1), 'workspace-%d' % index, 11, SUB)
    return 3 + len(rows)


def detail(img):
    """Detail split: the pane's title, path, tag and first message, plus the list."""
    mask_region(img, (536, 358, 800, 386), 'Session 1', 15, TITLE)
    mask_region(img, (640, 408, 862, 450), '/workspace/example/project', 11, TITLE)
    mask_region(img, (536, 548, 620, 572), 'tag-1', 11, TITLE)
    mask_region(img, (536, 758, 862, 870), 'First message of the session.', 11, TITLE)
    mask_list(img, 88, 500, 300, img.size[1], 'Session')
    # The selected row keeps its highlight, so its text is masked on top of the
    # tinted background rather than the plain one.
    mask_region(img, (88, 668, 500, 690), 'Session 7', 13, TITLE)
    mask_region(img, (88, 690, 500, 704), 'workspace-7', 11, SUB)
    mask_region(img, (88, 704, 500, 720), 'tag-7', 11, SUB)
    return 8


def native_sidebar(img):
    """Native sidebar: its own session list, the hover card, and the panel list.

    The hover card covers the middle of the panel list, so that column is masked
    by explicit row bands rather than by separator detection.
    """
    mask_list(img, 20, 200, 400, img.size[1], 'Session')
    # Hover card: title, the wrapped path, and the tag chip.
    mask_region(img, (290, 432, 500, 462), 'Session 1', 13, TITLE)
    mask_region(img, (290, 470, 520, 522), '/workspace/example/project', 11, TITLE)
    mask_region(img, (290, 545, 360, 575), 'tag-1', 11, TITLE)
    # Panel list rows (title + workspace), skipping the band the card covers.
    rows = [
        (312, 332, 336, 350),
        (368, 390, 392, 404),
        (404, 430, 430, 444),
        (600, 622, 622, 636),
        (624, 640, 640, 652),
        (654, 678, 678, 692),
        (704, 726, 726, 740),
        (744, 762, 762, 776),
        (778, 798, 798, 812),
        (828, 850, 850, 866),
    ]
    for index, (ty0, ty1, sy0, sy1) in enumerate(rows, start=1):
        mask_region(img, (330, ty0, 700, ty1), 'Session %d' % index, 13, TITLE)
        mask_region(img, (330, sy0, 700, sy1), 'workspace-%d' % index, 11, SUB)
    return 4 + len(rows)


HANDLERS = {
    '01-overview.png': overview,
    '02-tag-manager.png': tag_manager,
    '03-native-menu.png': native_menu,
    '04-detail.png': detail,
    '05-native-sidebar.png': native_sidebar,
}


def main():
    for name, handler in HANDLERS.items():
        path = os.path.join(HERE, name)
        img = Image.open(path).convert('RGB')
        n = handler(img)
        img.save(path)
        print('%-24s %d regions masked' % (name, n))


if __name__ == '__main__':
    main()
