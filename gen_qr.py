import qrcode
from qrcode.image.styledpil import StyledPilImage
from qrcode.image.styles.moduledrawers import RoundedModuleDrawer
from qrcode.image.styles.colormasks import SolidFillColorMask

URL = "https://wenqingfang.github.io/shift-workbench/"
JD_URL = "https://cdn.jsdelivr.net/gh/wenqingfang/shift-workbench@main/index.html"
ROOT = "D:/workBuddySpace/shift-workbench"

def make_standard(path, fill, back):
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_H,
        box_size=12,
        border=4,
    )
    qr.add_data(URL)
    qr.make(fit=True)
    img = qr.make_image(fill_color=fill, back_color=back)
    img.save(path)
    print("saved:", path)

def make_rounded(path):
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_H,
        box_size=14,
        border=4,
    )
    qr.add_data(URL)
    qr.make(fit=True)
    img = qr.make_image(
        image_factory=StyledPilImage,
        module_drawer=RoundedModuleDrawer(radius_ratio=0.8),
        color_mask=SolidFillColorMask(front_color=(26, 16, 48), back_color=(255, 255, 255)),
    )
    img.save(path)
    print("saved:", path)

if __name__ == "__main__":
    make_standard(f"{ROOT}/shift-workbench-qr-black.png", "#000000", "#ffffff")
    make_standard(f"{ROOT}/shift-workbench-qr-themed.png", "#1a1030", "#ffffff")
    make_rounded(f"{ROOT}/shift-workbench-qr-rounded.png")
    # jsDelivr 直链二维码（国内手机扫码直达，最快）
    qr = qrcode.QRCode(version=None, error_correction=qrcode.constants.ERROR_CORRECT_H,
                      box_size=14, border=4)
    qr.add_data(JD_URL)
    qr.make(fit=True)
    qr.make_image(fill_color="#1a1030", back_color="#ffffff").save(f"{ROOT}/shift-workbench-qr-jsdelivr.png")
    print("saved:", f"{ROOT}/shift-workbench-qr-jsdelivr.png")
