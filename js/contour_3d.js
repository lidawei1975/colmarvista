try {
    importScripts('d3.7.min.js');
} catch (e) {
    importScripts('https://d3js.org/d3.v7.min.js');
}

/**
 * Import local ldwmath.js and earcut.js
 */
importScripts('ldwmath.js');
importScripts('earcut.js');

onmessage = (e) => {

    let n_direct = e.data.n_direct;
    let n_indirect = e.data.n_indirect;
    let levels = e.data.levels;
    let new_spectrum_data = e.data.new_spectrum_data;
    let line_thickness = e.data.line_thickness;
    let plot_type_int = e.data.plot_type_int;

   
    let workerResult = get_contour_data(n_direct,n_indirect,levels,new_spectrum_data,line_thickness,plot_type_int);
    workerResult.n_direct = n_direct;
    workerResult.n_indirect = n_indirect;
    workerResult.plot_type_int = plot_type_int;
    postMessage({workerResult: workerResult});
};



/**
 * 
 * @param {int} n_direct: size of direct dimension of the input spectrum
 * @param {int} n_indirect: size of indirect dimension of the input spectrum
 * @param {array} levels: levels of the contour plot
 * @param {array} data: the spectrum data
 * @param {doube} thickness: thickness of the contour lines (when converting to 3D belts)
 * @param {int} flag: 0: smooth surface, 1: terrace surface 
 * @returns 
 */
function get_contour_data(n_direct,n_indirect,levels,data,thickness,flag)
{
    const mathTool = new ldwmath(); 

    postMessage({ message: "Calculating contour" });

    let polygons = d3.contours()
        .size([n_direct, n_indirect])
        .thresholds(levels)(data);

    /**
     * Calculate the edges and center of each polygon
     * @var polygons is an array of polygon, each have the following properties:
     * coordinates: an array of array of 2D coordinates of the polygon
     * edge_centers: an array of array of 6 numbers, each represent the edge center of the polygon
     * children: an array of array of array of 2 numbers, each represent the index of the children polygon
     */
    for (let i = 0; i < polygons.length; i++)
    {
        polygons[i].edge_centers = [];
        for (let j = 0; j < polygons[i].coordinates.length; j++)
        {
            let edge_centers = [];
            for (let k = 0; k < polygons[i].coordinates[j].length; k++)
            {
                let polygon = polygons[i].coordinates[j][k];
                let edge_center = mathTool.edgeAndCenter(polygon);
                edge_centers.push(edge_center);
            }
            polygons[i].edge_centers.push(edge_centers);
        }
    }


    /**
     * For each polygon at level i, let check all polygons at level i+1 to see whether it is inside the polygon at level i
     * If inside, add the index of polygon at level i+1 to polygons[i].children array
     * For the highest level, it has no children, but we still need to define polygons[i].children as an empty array
     */
    for (let i = 0; i < polygons.length; i++)
    {   
        polygons[i].children = [];
        /**
         * Notice that polygons[i].edge_centers is an array of array of 6 numbers.
         * The double array is used by d3.contours to represent the polygon of same level but with multiple components (holes at same level)
         */
        for(let j = 0; j < polygons[i].edge_centers.length; j++)
        {
            let children = [];
            for(let k = 0; k < polygons[i].edge_centers[j].length; k++)
            {
                let child = [];
                /**
                 * Edge center of polygon at level i, polygon[j][k] is an array of 6 numbers
                 */
                let edge_center_i = polygons[i].edge_centers[j][k];

                if(i < polygons.length - 1)
                {
                    let i2 = i + 1;
                    for(let j2 = 0; j2 < polygons[i2].edge_centers.length; j2++)
                    {
                        for(let k2 = 0; k2 < polygons[i2].edge_centers[j2].length; k2++)
                        {
                            /**
                             * Edge center of polygon at level i+1, polygon[j2][k2] is an array of 6 numbers
                             */
                            let edge_center_i2 = polygons[i2].edge_centers[j2][k2];

                            /**
                             * Check if edge_center_i2 is inside edge_center_i
                             * Step 1: if center of polygon at level i+1 is outside edge of polygon at level i, then it is not inside
                             * Step 2: run rayIntersectsLine for center of polygon at level i+1 and all edges of polygon at level i
                             */
                            let inside = false;

                            let center_x_i2 = edge_center_i2.center_x;
                            let center_y_i2 = edge_center_i2.center_y;

                            if(center_x_i2 > edge_center_i.left && center_x_i2 < edge_center_i.right && center_y_i2 > edge_center_i.bottom && center_y_i2 < edge_center_i.top)
                            {
                                /**
                                 * Run rayIntersectsLine for center of polygon at level i+1 and all edges of polygon at level i
                                 */
                                for(let l = 0; l < polygons[i].coordinates[j][k].length -1; l++)
                                {
                                    let line_start = polygons[i].coordinates[j][k][l];
                                    let line_end = polygons[i].coordinates[j][k][l+1];
                                    let ray_origin = [center_x_i2,center_y_i2];
                                    let ray_direction = [1,0];
                                    let intersection = mathTool.rayIntersectsLine(ray_origin,ray_direction,line_start,line_end);
                                    if(intersection !== null)
                                    {
                                        // console.log("intersection",ray_origin,line_start,line_end,intersection);
                                        inside = !inside;
                                    }
                                }
                            }

                            if(inside)
                            {
                                child.push([j2,k2]);
                            }
                        }
                    }
                }
                children.push(child);
            }
            polygons[i].children.push(children); 
        }
    }
    
    /**
     * Array of 3D coordinates of the triangles for webgl 3D plot
     */
    let triangle_surface = []; 
    let triangle_normals = [];
    postMessage({ message: "Triangulating contour" });
    /**
     * For each polygon, triangulate them.
     * If it has children, define the children as a hole of the polygon
     */
    for(let i = 0; i < polygons.length; i++)
    {
        for(let j = 0; j < polygons[i].coordinates.length; j++)
        {
            for (let k = 0; k < polygons[i].coordinates[j].length; k++)
            {

                let hole_locations = [];
                /**
                 * Deep copy the polygon to a new array
                 */
                let polygon = [...polygons[i].coordinates[j][k]];
                for (let l = 0; l < polygons[i].children[j][k].length; l++) {
                    let child = polygons[i].children[j][k][l];
                    let child_polygon = polygons[i + 1].coordinates[child[0]][child[1]];
                    /**
                     * Define a new polygon with the child_polygon as a hole. Track the hold by
                     * keeping the starting location of each hole
                     */
                    hole_locations.push(polygon.length);
                    polygon = polygon.concat(child_polygon);
                }

                /**
                 * Run earcut to triangulate the polygon with holes
                 * @var triangles is an array of indices of the vertices of the triangles, 3 indices represent a triangle
                 */
                let triangles = earcut(polygon.flat(), hole_locations, 2);

                /**
                 * Convert the triangles to 3D coordinates for webgl 3D triangle plot
                */
                for (let l = 0; l < triangles.length; l += 3)
                {
                    for (let m = 0; m < 3; m++)
                    {
                        let triangle_m = triangles[l + m];

                        let x = polygon[triangle_m][0];
                        let y = polygon[triangle_m][1];
                        let z = levels[i];
                        /**
                         * Only if flag ==0: If triangle_0 is in the hole, set z to i+1, otherwise set z to i
                         * For terrace surface, always set z to levels[i]
                         */
                        if (flag == 0 && triangle_m >= hole_locations[0]) {
                            z = levels[i + 1];
                        }
                        triangle_surface.push([x, y, z]);
                        if(flag==1)
                        {
                            triangle_normals.push([0,0,1]); //normal of the triangle is alway [0,0,1] for terrace surface    
                        }
                    }
                }

                /**
                 * For terrace surface, add the triangles for the vertical walls
                 * No vertical walls for the lowest level
                 */
                if (flag == 1 && i > 0)
                {
                    let polygon = [...polygons[i].coordinates[j][k]];
                    for (let l = 0; l < polygon.length - 1; l++)
                    {
                        /**
                         * For the rectangle, the coordinates are:
                         * 1. polygon[l][0], polygon[l][1], levels[i]
                         * 2. polygon[l][0], polygon[l][1], levels[i-1]
                         * 3. polygon[l+1][0], polygon[l+1][1], levels[i]
                         * 4. polygon[l+1][0], polygon[l+1][1], levels[i-1]
                         * 1,2,3 and 3,2,4 are two triangles
                         * All triangles are vertical, normal is (polygon[l+1] - polygon[l])'
                         */
                        let normal = [polygon[l + 1][1] - polygon[l][1], -polygon[l+1][0] + polygon[l][0], 0];
                        /**
                         * Need to normalize the normal
                         */
                        let normal_length = Math.sqrt(normal[0]*normal[0] + normal[1]*normal[1]);
                        normal[0] /= normal_length;
                        normal[1] /= normal_length;
                         
                        let x1 = polygon[l][0];
                        let y1 = polygon[l][1];
                        let z1 = levels[i];
                        let x2 = polygon[l][0];
                        let y2 = polygon[l][1];
                        let z2 = levels[i - 1];
                        let x3 = polygon[l + 1][0];
                        let y3 = polygon[l + 1][1];
                        let z3 = levels[i];
                        let x4 = polygon[l + 1][0];
                        let y4 = polygon[l + 1][1];
                        let z4 = levels[i - 1];
                        triangle_surface.push([x1, y1, z1]);
                        triangle_surface.push([x2, y2, z2]);
                        triangle_surface.push([x3, y3, z3]);
                        triangle_surface.push([x3, y3, z3]);
                        triangle_surface.push([x2, y2, z2]);
                        triangle_surface.push([x4, y4, z4]);
                        for(let m=0;m<6;m++)
                        {
                            triangle_normals.push(normal);
                        }
                    }
                }
            } 
        }
    }

    /**
     * @var triangle_contour is an array of 3D coordinates of the triangles
     * that are converted from the contour lines
     */
    let triangle_contour = [];

    /**
     * Only draw contour lines (as belt) when flag == 0
     */
    if(flag==0)
    {
        /**
         * m is the index of the level
         */
        for (let m = 0; m < polygons.length; m++)
        {
            for (let i = 0; i < polygons[m].coordinates.length; i++) 
            {
                for (let j = 0; j < polygons[m].coordinates[i].length; j++)
                {
                    /**
                     * coors2 is an array of 2D coordinates of the polygon
                     */
                    let coors2 = polygons[m].coordinates[i][j];
                    /**
                     * Each line segment is defined by two points
                     * workerResult.points is an array of 3D coordinates of the points
                     */
                    for(let k = 0; k < coors2.length - 1; k++)
                    {
                        
                        let p1_x = coors2[k][0];
                        let p1_y = coors2[k][1];

                        let p2_x = coors2[k + 1][0];
                        let p2_y = coors2[k + 1][1];

                        let pz = levels[m];
                        
                        /**
                         * Calculate the normal of the line segment
                         */
                        let normal_x = p2_y - p1_y;
                        let normal_y = p1_x - p2_x;
                        let normal_length = Math.sqrt(normal_x*normal_x + normal_y*normal_y);
                        normal_x /= normal_length;
                        normal_y /= normal_length;
                        
                        /**
                         * Thickness of the line segment is 1.0, so we extend the line segment by 0.5 in both directions
                         */
                        normal_x *= thickness;
                        normal_y *= thickness; 
        
                        /**
                         * Line segment ==> 2 triangles. They are parallel to the xy plane
                        */
                        let p1 = [p1_x + normal_x, p1_y + normal_y, pz];
                        let p2 = [p1_x - normal_x, p1_y - normal_y, pz];
                        let p3 = [p2_x + normal_x, p2_y + normal_y, pz];
                        let p4 = [p2_x - normal_x, p2_y - normal_y, pz];
        
                        triangle_contour.push(p1);
                        triangle_contour.push(p2);
                        triangle_contour.push(p3);
                        triangle_contour.push(p2);
                        triangle_contour.push(p3);
                        triangle_contour.push(p4);

                        /**
                         * Add triangles that are perpendicular to the xy plane
                         */
                        let pp1 = [p1_x, p1_y, levels[m]+thickness];
                        let pp2 = [p1_x, p1_y, levels[m]-thickness];
                        let pp3 = [p2_x, p2_y, levels[m]+thickness];
                        let pp4 = [p2_x, p2_y, levels[m]-thickness];

                        triangle_contour.push(pp1);
                        triangle_contour.push(pp2);
                        triangle_contour.push(pp3);
                        triangle_contour.push(pp2);
                        triangle_contour.push(pp3);
                        triangle_contour.push(pp4);
                        
                    }
                }
            }
        }
    }


    let contour_result = new Object();

    contour_result.triangle_surface = triangle_surface;
    contour_result.triangle_contour = triangle_contour;
    contour_result.triangle_normals = triangle_normals;
    return contour_result;
}

