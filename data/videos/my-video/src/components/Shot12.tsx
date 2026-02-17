import {
	AbsoluteFill,
	interpolate,
	useCurrentFrame,
	useVideoConfig,
	Img,
	staticFile,
	Audio,
	Easing,
} from 'remotion';
import React from 'react';

export const Shot12: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Timeline scaling: 7.25s total
	// Segments: 0-5s, 5-10s, 10-15s (scaled)
	const segment1End = Math.round((5 / 15) * durationInFrames);
	const segment2End = Math.round((10 / 15) * durationInFrames);

	// Transitions
	const isProhibition = frame >= segment2End;

	// Dissolve opacity for corridor
	const corridorOpacity = interpolate(
		frame,
		[segment1End, segment1End + 15],
		[0, 1],
		{extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
	);

	// Child Silhouette Appearance
	const childOpacity = interpolate(
		frame,
		[segment2End, segment2End + 15],
		[0, 1],
		{extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
	);

	// Red X Animation
	const xProgress = interpolate(
		frame,
		[segment2End + 10, segment2End + 25],
		[0, 1],
		{extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.back(1.5)}
	);

	return (
		<AbsoluteFill style={{backgroundColor: 'white'}}>
			{/* Segment 1: Exterior */}
			{frame < segment2End && (
				<AbsoluteFill>
					<Img
						src={staticFile('zags_building.png')}
						style={{
							width: '100%',
							height: '100%',
							objectFit: 'cover',
						}}
					/>
				</AbsoluteFill>
			)}

			{/* Segment 2: Corridor */}
			<AbsoluteFill style={{opacity: corridorOpacity}}>
				<Img
					src={staticFile('zags_corridor.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
					}}
				/>
			</AbsoluteFill>

			{/* Segment 3: Child Silhouette & Prohibition */}
			<AbsoluteFill
				className="justify-center items-center"
				style={{opacity: childOpacity}}
			>
				<div className="relative">
					{/* Placeholder for child silhouette if zags_corridor doesn't have it, 
					    but the instruction says "silhouette appears", implying a separate element.
						Using a simple silhouette representation if needed or just focusing on the X.
					*/}
					<div 
						className="w-64 h-96 bg-black rounded-t-full opacity-80"
						style={{maskImage: 'linear-gradient(to bottom, black 80%, transparent)'}}
					/>
					
					{/* Red X */}
					<AbsoluteFill className="justify-center items-center">
						<div 
							style={{
								width: 300,
								height: 300,
								transform: `scale(${xProgress})`,
							}}
						>
							<div className="absolute top-1/2 left-0 w-full h-8 bg-red-600 rotate-45" />
							<div className="absolute top-1/2 left-0 w-full h-8 bg-red-600 -rotate-45" />
						</div>
					</AbsoluteFill>
				</div>
			</AbsoluteFill>

			{/* Overlay Text */}
			{isProhibition && (
				<AbsoluteFill className="justify-end items-center pb-20">
					<div className="bg-white/80 px-8 py-4 rounded-full flex flex-row items-center space-x-4 border-4 border-red-600">
						<span className="text-4xl">👶</span>
						<span className="text-red-600 text-5xl font-black uppercase tracking-widest" style={{fontFamily: 'Inter, sans-serif'}}>
							восемнадцать лет
						</span>
						<span className="text-4xl text-red-600 font-bold">✕</span>
					</div>
				</AbsoluteFill>
			)}

			<Audio src={staticFile('shot12_voice.mp3')} />
		</AbsoluteFill>
	);
};
