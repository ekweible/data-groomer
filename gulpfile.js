var gulp = require('gulp');

// Override default options (such as path) here
var customizedOptions = {
    path: {
        styles: './src/sass/'
    },
    build_tasks: ['clean', ['lint'], ['sass', 'jsx', 'copy:js'], 'copy:css', 'bundle'],
    dist_tasks: ['clean', 'build'],
    bundles: {
        dataGroomer: {
            bundler: 'jspm',
            entry: 'build/src/dataGroomer',
            output: 'dist/dataGroomer.js',
            sfx: true
        }
    }
};

var wGulp = require('wGulp')(gulp, customizedOptions);

gulp.task('copy:css', wGulp.copy({
    src: [
        './build/css/**/*.css',
        './node_modules/normalize.css/normalize.css'
    ],
    dest: wGulp.config.path.dist
}));
