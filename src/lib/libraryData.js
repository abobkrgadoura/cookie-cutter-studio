/**
 * Production library presets. Each card shows `image` and, on click,
 * `svg` is passed to `parseSvgToPaths` before the designer opens.
 *
 * Circle is the supplied production path. Heart, Rectangular, Oval, Arch,
 * and Square are closed outlines under those names.
 *
 * Thumbnails are imported so Vite emits them with `base: './'` (Electron).
 */
import archImg from '../assets/designs/arch.png'
import circleImg from '../assets/designs/circle.png'
import heartImg from '../assets/designs/heart.png'
import ovalImg from '../assets/designs/oval.png'
import rectangularImg from '../assets/designs/rectangular.png'
import squareImg from '../assets/designs/square.png'

/** Settings applied when any library preset is opened in the designer. */
export const LIBRARY_CUTTER_PROFILE = {
  thingToMake: 'cutter',
  bladeDepth: 14,
  bladeThickness: 1.8,
  size: 60,
  sharpCutter: true,
}

const CIRCLE_SVG = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg viewBox="14 48 190 192" xmlns="http://www.w3.org/2000/svg"><g><path fill="#000000" d="m 101.99565,231.28001 c -8.326557,-0.76473 -13.825579,-1.90569 -21.147029,-4.38767 -5.1866,-1.75826 -10.33472,-4.07392 -15.10089,-6.79248 -3.59444,-2.05023 -8.01165,-5.05826 -11.53251,-7.8534 -4.23063,-3.35861 -8.66777,-7.69055 -11.75082,-11.47222 -0.87313,-1.07097 -1.95622,-2.38066 -2.40687,-2.91041 -0.95746,-1.12553 -3.70358,-5.01265 -4.73148,-6.69738 -1.71721,-2.81455 -3.74257,-6.47451 -4.95287,-8.95019 -2.60559,-5.32976 -4.52519,-10.59949 -6.0719,-16.66875 -1.80449,-7.08073 -2.59443,-13.5091 -2.60102,-21.16667 -0.004,-5.10229 0.40087,-10.52066 1.05875,-14.15521 0.15804,-0.87312 0.39319,-2.18281 0.52256,-2.91041 0.31218,-1.75573 0.47165,-2.45124 1.24367,-5.42396 0.69746,-2.68562 2.92608,-9.48217 3.25343,-9.92188 0.10834,-0.14552 0.34422,-0.72145 0.52418,-1.27985 0.57878,-1.79589 4.52562,-9.47812 6.41098,-12.47848 2.52974,-4.025829 3.68527,-5.644824 6.62678,-9.284665 4.38085,-5.420883 11.70065,-12.282295 17.19603,-16.119156 3.54407,-2.474462 7.65496,-4.90228 11.75207,-6.940558 2.35202,-1.170109 4.73327,-2.274712 5.29167,-2.454673 0.5584,-0.179961 1.13433,-0.41584 1.27985,-0.524177 0.43971,-0.327347 7.23626,-2.555968 9.92188,-3.253426 2.97272,-0.772021 3.66823,-0.931496 5.42395,-1.24367 0.727612,-0.129371 2.037292,-0.364526 2.910422,-0.522567 3.63454,-0.657876 9.052917,-1.063148 14.155207,-1.058751 7.65756,0.0066 14.08594,0.796536 21.16666,2.60102 6.06926,1.546718 11.33899,3.466318 16.66875,6.071905 2.47569,1.210302 6.13565,3.235658 8.95019,4.952874 1.68473,1.027892 5.57185,3.774014 6.69738,4.731475 0.52976,0.450653 1.83944,1.533744 2.91042,2.406869 3.78166,3.083056 8.1136,7.520195 11.47222,11.750825 2.79514,3.520855 5.80316,7.938065 7.85339,11.532505 2.71856,4.76617 5.03422,9.91429 6.79248,15.10089 1.46021,4.30738 2.03022,6.39725 2.80908,10.29911 1.10347,5.52812 1.34914,7.37216 1.76819,13.27236 0.2562,3.60733 0.25402,5.53872 -0.0106,9.39271 -0.18322,2.66838 -0.436,5.50644 -0.56174,6.30681 -0.12575,0.80036 -0.36436,2.34817 -0.53027,3.43958 -0.79238,5.21279 -2.55545,11.5511 -4.8206,17.33021 -2.07261,5.28789 -5.65201,12.20439 -8.62622,16.66852 -1.28917,1.93498 -5.36563,7.26637 -6.7312,8.80339 -4.17902,4.7037 -8.73845,8.94137 -13.33734,12.39612 -1.71955,1.29175 -3.6026,2.66586 -4.18456,3.05359 -4.46412,2.97421 -11.38063,6.5536 -16.66852,8.62622 -5.77336,2.26289 -12.09777,4.02267 -17.33021,4.82217 -1.0914,0.16676 -2.28203,0.35321 -2.64583,0.41433 -0.3638,0.0611 -2.74505,0.2902 -5.29167,0.50906 -2.54661,0.21887 -5.82083,0.38226 -7.27604,0.3631 -1.4552,-0.0192 -4.3127,-0.18793 -6.34999,-0.37504 z"/></g></svg>`

const HEART_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#000000" d="M50 86C28 70 8 54 8 34 8 20 18 10 30 10c8 0 14 4 20 12C56 14 62 10 70 10c12 0 22 10 22 24 0 20-20 36-42 52z"/></svg>`

const RECTANGULAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#000000" d="M12 28H88V72H12Z"/></svg>`

const OVAL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#000000" d="M10 50a40 26 0 1 0 80 0a40 26 0 1 0-80 0z"/></svg>`

const ARCH_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#000000" d="M20 82V48a30 30 0 0 1 60 0V82Z"/></svg>`

const SQUARE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#000000" d="M16 16H84V84H16Z"/></svg>`

export const LIBRARY_DESIGNS = [
  { id: 'circle', name: 'Circle', image: circleImg, svg: CIRCLE_SVG },
  { id: 'heart', name: 'Heart', image: heartImg, svg: HEART_SVG },
  { id: 'rectangular', name: 'Rectangular', image: rectangularImg, svg: RECTANGULAR_SVG },
  { id: 'oval', name: 'Oval', image: ovalImg, svg: OVAL_SVG },
  { id: 'arch', name: 'Arch', image: archImg, svg: ARCH_SVG },
  { id: 'square', name: 'Square', image: squareImg, svg: SQUARE_SVG },
]
