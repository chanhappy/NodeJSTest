const sharp = require('sharp');
sharp('back.png').resize(800, 600).toFile('out.png');