var compileTypescript = require('threax-gulp-tk/typescript.js');

module.exports = function (rootDir, outDir, settings) {
    if(settings === undefined){
        settings = {};
    }

    var concat = true;
    if(settings.concat !== undefined){
        concat = settings.concat;
    }

    var minify = true;
    if(settings.minify !== undefined){
        minify = settings.minify;
    }

    return compileTypescript({
        libs: [
            __dirname + "/src/**/*.ts",
        ],
        runners: [
            
        ],
        output: "HtmlRapierWidgets",
        dest: outDir,
        sourceRoot: __dirname + "/src/",
        namespace: "hr.widgets",
        concat: concat,
        minify: minify
    });
}